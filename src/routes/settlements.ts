import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { stellar } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit } from "../services/audit";
import { rateLimited } from "../lib/rate-limit";
import { readIdempotencyKey, runIdempotent } from "../services/idempotency";
import {
  serializeSettlement,
  serializeExpense,
  serializeTreasuryTx,
} from "../serializers";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";
import {
  loadGroupBalancesWithSuggestions,
  groupPrimaryAsset,
} from "../services/group-balances";
import { validateAsset, validateAmount } from "../services/assets";
import { memoText } from "../services/stellar";

const settlementInclude = { from: true, to: true } as const;

/** Every route in this file takes a single opaque resource id. */
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

export default async function settlementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Settlement submission builds a real Stellar payment XDR (create) or
  // hands a signed one off for submission (confirm) — both are the kind of
  // expensive, state-changing operation that needs its own explicit budget
  // rather than sharing the blanket global limit, and neither shares a bucket
  // with the read routes below. Both policies run as a preHandler (after the
  // app.authenticate hook above sets req.user) so the key is the authenticated
  // user rather than falling back to IP.
  const createLimit = rateLimited("settlementCreate");
  const confirmLimit = rateLimited("settlementConfirm");

  // -- settle a specific expense share ----------------------------------------
  app.post("/expenses/:id/settle", createLimit, async (req) => {
    const auth = requireUser(req);
    const { id: expenseId } = idParamSchema.parse(req.params);
    const body = z
      .object({
        assetCode: z.string().optional(),
        assetIssuer: z.string().nullable().optional(),
      })
      .parse(req.body ?? {});
    const idempotencyKey = readIdempotencyKey(req.headers);

    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { shares: true, payer: true },
    });
    if (!expense) throw Errors.notFound("Expense not found");
    await requireMembership(expense.groupId, auth.id);

    const myShare = expense.shares.find((s) => s.userId === auth.id);
    if (!myShare) throw Errors.badRequest("no_share", "You have no share in this expense");
    if (myShare.status === "settled") {
      throw Errors.conflict("already_settled", "Your share is already settled");
    }
    if (expense.payerUserId === auth.id) {
      throw Errors.badRequest("payer_share", "You are the payer of this expense");
    }

    const assetCode = body.assetCode ?? expense.assetCode;
    const assetIssuer =
      body.assetCode !== undefined ? body.assetIssuer ?? null : expense.assetIssuer;

    return runIdempotent({
      userId: auth.id,
      scope: "settlement.create",
      key: idempotencyKey,
      resourceId: expenseId,
      payload: body,
      operation: async (tx) => {
        // Re-check inside the atomic unit: a concurrent request without an
        // idempotency key (or a different one) could have already settled
        // this share while this request was validating above.
        const freshShare = await tx.expenseShare.findUnique({ where: { id: myShare.id } });
        if (!freshShare || freshShare.status === "settled") {
          throw Errors.conflict("already_settled", "Your share is already settled");
        }

        const code = shortCode();
        const settlement = await tx.settlement.create({
          data: {
            shortCode: code,
            groupId: expense.groupId,
            fromUserId: auth.id,
            toUserId: expense.payerUserId,
            amount: myShare.shareAmount,
            assetCode,
            assetIssuer,
            status: "pending",
            memo: memoText(code),
            expenseId: expense.id,
            expenseShareId: myShare.id,
          },
          include: settlementInclude,
        });

        await tx.expenseShare.update({
          where: { id: myShare.id },
          data: { status: "settling" },
        });

        const xdr = await buildSettlementXdr({
          fromPublicKey: auth.stellarPublicKey,
          toPublicKey: expense.payer.stellarPublicKey,
          assetCode,
          assetIssuer,
          amount: myShare.shareAmount.toString(),
          memoCode: code,
        });

        return {
          settlement: serializeSettlement(settlement),
          xdr,
          networkPassphrase: config.networkPassphrase,
        };
      },
    });
  });

  // -- freeform settle-up against net balance ---------------------------------
  app.post("/groups/:id/settlements", createLimit, async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = idParamSchema.parse(req.params);
    await requireMembership(groupId, auth.id);
    const body = z
      .object({
        toUserId: z.string(),
        amount: z.string().min(1),
        assetCode: z.string().min(1),
        assetIssuer: z.string().nullable().optional(),
      })
      .parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    validateAmount(body.amount);
    validateAsset(body.assetCode, body.assetIssuer ?? null);

    if (body.toUserId === auth.id) {
      throw Errors.badRequest("self_settle", "You cannot settle with yourself");
    }
    const recipient = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: body.toUserId } },
      include: { user: true },
    });
    if (!recipient) throw Errors.badRequest("invalid_recipient", "Recipient is not a member");

    return runIdempotent({
      userId: auth.id,
      scope: "settlement.create",
      key: idempotencyKey,
      resourceId: groupId,
      payload: body,
      operation: async (tx) => {
        const code = shortCode();
        const settlement = await tx.settlement.create({
          data: {
            shortCode: code,
            groupId,
            fromUserId: auth.id,
            toUserId: body.toUserId,
            amount: body.amount,
            assetCode: body.assetCode,
            assetIssuer: body.assetIssuer ?? null,
            status: "pending",
            memo: memoText(code),
          },
          include: settlementInclude,
        });

        const xdr = await buildSettlementXdr({
          fromPublicKey: auth.stellarPublicKey,
          toPublicKey: recipient.user.stellarPublicKey,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          amount: body.amount,
          memoCode: code,
        });

        return {
          settlement: serializeSettlement(settlement),
          xdr,
          networkPassphrase: config.networkPassphrase,
        };
      },
    });
  });

  // -- confirm (submit signed xdr) --------------------------------------------
  app.post("/settlements/:id/confirm", confirmLimit, async (req, reply) => {
    const auth = requireUser(req);
    const { id } = idParamSchema.parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    return runIdempotent({
      userId: auth.id,
      scope: "settlement.confirm",
      key: idempotencyKey,
      resourceId: id,
      payload: body,
      operation: async (tx) => {
        const settlement = await tx.settlement.findUnique({
          where: { id },
          include: settlementInclude,
        });
        if (!settlement) throw Errors.notFound("Settlement not found");
        if (settlement.fromUserId !== auth.id) {
          throw Errors.forbidden("Only the payer can confirm this settlement");
        }

        // Already confirmed, or moved past "pending" by a prior (possibly
        // concurrent) confirm — return the current state rather than
        // re-submitting or erroring, so retries are always safe.
        if (settlement.status !== "pending") {
          return { settlement: serializeSettlement(settlement) };
        }

        // Guard the transition with a conditional update rather than an
        // unconditional one: if a concurrent confirm on the same settlement
        // (e.g. a different idempotency key, or no key at all) already won
        // the race and moved the status off "pending" between the read
        // above and here, this update affects zero rows and we simply
        // re-read the winning state instead of clobbering it.
        const { count } = await tx.settlement.updateMany({
          where: { id, status: "pending" },
          data: {
            transactionXdr: body.signedXdr,
            status: "submitted",
          },
        });

        const finalSettlement = await tx.settlement.findUniqueOrThrow({
          where: { id },
          include: settlementInclude,
        });

        if (count > 0) {
          await audit({
            userId: auth.id,
            action: "settlement.confirm",
            entityType: "settlement",
            entityId: id,
            metadata: { status: "submitted" },
          });
        }

        return { settlement: serializeSettlement(finalSettlement) };
      },
    });
  });

  // -- balances + suggestions -------------------------------------------------
  app.get("/groups/:id/balances", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = idParamSchema.parse(req.params);
    await requireMembership(groupId, auth.id);

    const { balances, suggestions } = await loadGroupBalancesWithSuggestions(groupId);

    const userIds = new Set<string>();
    balances.forEach((b) => userIds.add(b.userId));
    suggestions.forEach((s) => {
      userIds.add(s.fromUserId);
      userIds.add(s.toUserId);
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [...userIds] } },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const asset = await groupPrimaryAsset(groupId);

    return {
      balances: balances
        .filter((b) => userMap.has(b.userId))
        .map((b) => ({
          userId: b.userId,
          user: serializeUserSafe(userMap.get(b.userId)),
          net: b.net,
          assetCode: asset.assetCode,
        })),
      suggestions: suggestions.map((s) => ({
        fromUserId: s.fromUserId,
        from: serializeUserSafe(userMap.get(s.fromUserId)),
        toUserId: s.toUserId,
        to: serializeUserSafe(userMap.get(s.toUserId)),
        amount: s.amount,
        assetCode: asset.assetCode,
        assetIssuer: asset.assetIssuer,
      })),
    };
  });

  // -- ledger -----------------------------------------------------------------
  //
  // The ledger interleaves three tables. Each is read with the same bounded
  // `limit + 1` window and the same `(createdAt, id)` ordering, then merged
  // using that identical total order, so the merged page obeys the shared
  // pagination contract: a cursor from any page resumes exactly where the last
  // one stopped, whichever table the boundary row came from.
  app.get("/groups/:id/ledger", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = idParamSchema.parse(req.params);
    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    await requireMembership(groupId, auth.id);

    const position = requireCursor(cursor);
    const where = { groupId, ...cursorFilter(position, order) };
    const orderBy = cursorOrderBy(order);
    const take = takeForPage(limit);

    const [expenses, settlements, treasuryTxs] = await Promise.all([
      prisma.expense.findMany({
        where,
        include: { payer: true, shares: { include: { user: true } } },
        orderBy,
        take,
      }),
      prisma.settlement.findMany({
        where,
        include: settlementInclude,
        orderBy,
        take,
      }),
      prisma.treasuryTransaction.findMany({
        where,
        include: { user: true },
        orderBy,
        take,
      }),
    ]);

    const direction = order === "desc" ? -1 : 1;
    const entries = [
      ...expenses.map((e) => ({
        type: "expense" as const,
        createdAt: e.createdAt,
        id: e.id,
        expense: serializeExpense(e),
      })),
      ...settlements.map((s) => ({
        type: "settlement" as const,
        createdAt: s.createdAt,
        id: s.id,
        settlement: serializeSettlement(s),
      })),
      ...treasuryTxs.map((t) => ({
        type: "treasury" as const,
        createdAt: t.createdAt,
        id: t.id,
        treasuryTransaction: serializeTreasuryTx(t),
      })),
    ].sort((a, b) => {
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return a.createdAt < b.createdAt ? -direction : direction;
      }
      // Ids from different tables can collide in sort position only by string
      // comparison, which is still a total order — the same one the per-table
      // queries used, so the merge stays consistent with the cursor.
      if (a.id === b.id) return 0;
      return a.id < b.id ? -direction : direction;
    });

    const { items, meta } = buildPage(entries, limit, order);

    return {
      entries: items.map(({ id: _id, createdAt, ...rest }) => ({
        ...rest,
        createdAt: createdAt.toISOString(),
      })),
      meta,
    };
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function buildSettlementXdr(params: {
  fromPublicKey: string;
  toPublicKey: string;
  assetCode: string;
  assetIssuer: string | null;
  amount: string;
  memoCode: string;
}): Promise<string> {
  const account = await stellar.loadAccount(params.fromPublicKey);
  if (!account.exists) {
    throw Errors.badRequest(
      "account_unfunded",
      "Your Stellar account is not funded yet. Fund it before settling."
    );
  }
  return stellar.buildPayment({
    sourcePublicKey: params.fromPublicKey,
    sourceSequence: account.sequence,
    destination: params.toPublicKey,
    asset: { code: params.assetCode, issuer: params.assetIssuer },
    amount: params.amount,
    memoCode: params.memoCode,
  });
}

function serializeUserSafe(u: any) {
  return u
    ? {
        id: u.id,
        stellarPublicKey: u.stellarPublicKey,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl ?? null,
        createdAt: u.createdAt.toISOString(),
      }
    : null;
}
