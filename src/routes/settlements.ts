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
import { readIdempotencyKey, runIdempotent } from "../services/idempotency";
import {
  serializeSettlement,
  serializeExpense,
  serializeTreasuryTx,
} from "../serializers";
import {
  loadGroupBalancesWithSuggestions,
  groupPrimaryAsset,
} from "../services/group-balances";
import { memoText } from "../services/stellar";

const settlementInclude = { from: true, to: true } as const;

export default async function settlementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- settle a specific expense share ----------------------------------------
  app.post("/expenses/:id/settle", async (req) => {
    const auth = requireUser(req);
    const { id: expenseId } = z.object({ id: z.string() }).parse(req.params);
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
  app.post("/groups/:id/settlements", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
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
  app.post("/settlements/:id/confirm", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
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
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
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
  app.get("/groups/:id/ledger", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const [expenses, settlements, treasuryTxs] = await Promise.all([
      prisma.expense.findMany({
        where: { groupId },
        include: { payer: true, shares: { include: { user: true } } },
      }),
      prisma.settlement.findMany({
        where: { groupId },
        include: { from: true, to: true },
      }),
      prisma.treasuryTransaction.findMany({
        where: { groupId },
        include: { user: true },
      }),
    ]);

    const entries = [
      ...expenses.map((e) => ({
        type: "expense" as const,
        createdAt: e.createdAt.toISOString(),
        expense: serializeExpense(e),
      })),
      ...settlements.map((s) => ({
        type: "settlement" as const,
        createdAt: s.createdAt.toISOString(),
        settlement: serializeSettlement(s),
      })),
      ...treasuryTxs.map((t) => ({
        type: "treasury" as const,
        createdAt: t.createdAt.toISOString(),
        treasuryTransaction: serializeTreasuryTx(t),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return { entries };
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
