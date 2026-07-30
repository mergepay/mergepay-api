import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { stellar } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit, auditTx } from "../services/audit";
import { userOrIpKey } from "../services/rate-limit-keys";
import {
  serializeSettlement,
  serializeExpense,
  serializeTreasuryTx,
} from "../serializers";
import { paginationQuerySchema, encodeCursor, decodeCursor } from "../lib/pagination";
import {
  loadGroupBalancesWithSuggestions,
  groupPrimaryAsset,
} from "../services/group-balances";
import { memoText } from "../services/stellar";
import { paginationQuerySchema } from "../services/pagination";
import { validateAsset, validateAmount } from "../services/assets";
import { memoText, validateSignedXdr } from "../services/stellar";
import { readIdempotencyKey, runIdempotent } from "../services/idempotency";

const settlementInclude = { from: true, to: true, statusHistory: true } as const;

export default async function settlementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Settlement submission builds a real Stellar payment XDR (create) or
  // hands a signed one off for submission (confirm) — both are the kind of
  // expensive, state-changing operation that needs its own explicit budget
  // rather than sharing the blanket global limit. Rate-limiting runs as a
  // preHandler (after the app.authenticate hook above sets req.user) so the
  // key can be the authenticated user rather than falling back to IP.
  const createLimit = {
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_SETTLEMENT_CREATE_MAX,
        timeWindow: config.RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS,
        hook: "preHandler" as const,
        keyGenerator: userOrIpKey("settlement.create"),
      },
    },
  };
  const confirmLimit = {
    config: {
      rateLimit: {
        max: config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX,
        timeWindow: config.RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS,
        hook: "preHandler" as const,
        keyGenerator: userOrIpKey("settlement.confirm"),
      },
    },
  };

  // -- settle a specific expense share ----------------------------------------
  app.post("/expenses/:id/settle", createLimit, async (req) => {
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

        await recordStatusTransitionInTransaction(tx, {
          entityType: "settlement",
          entityId: settlement.id,
          newStatus: "pending",
          source: "api",
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

        await recordStatusTransitionInTransaction(tx, {
          entityType: "settlement",
          entityId: settlement.id,
          newStatus: "pending",
          source: "api",
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
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    // Idempotency key is REQUIRED for settlement submission so that retries
    // can never create duplicate on-chain payments.
    if (!idempotencyKey) {
      throw Errors.badRequest(
        "missing_idempotency_key",
        "Idempotency-Key header is required for settlement confirmation"
      );
    }

    // Validate the signed XDR against the DB intent BEFORE entering the
    // idempotent operation so that validation failures are never cached
    // as idempotent successes and the client gets a fresh error each time.
    const settlementRow = await prisma.settlement.findUnique({
      where: { id },
      include: settlementInclude,
    });
    if (!settlementRow) throw Errors.notFound("Settlement not found");
    if (settlementRow.fromUserId !== auth.id) {
      throw Errors.forbidden("Only the payer can confirm this settlement");
    }

    try {
      validateSignedXdr(body.signedXdr, {
        sourcePublicKey: settlementRow.from.stellarPublicKey,
        destination: settlementRow.to.stellarPublicKey,
        asset: {
          code: settlementRow.assetCode,
          issuer: settlementRow.assetIssuer,
        },
        amount: String(settlementRow.amount),
        memoCode: settlementRow.shortCode,
      });
    } catch (err) {
      await audit({
        userId: auth.id,
        action: "settlement.confirm.validation_failed",
        entityType: "settlement",
        entityId: id,
        metadata: {
          reason: err instanceof Error ? err.message : "validation failed",
        },
      });
      throw err;
    }

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

        // Already completed or submitted — return the current state rather
        // than re-submitting or erroring, so retries are always safe.
        if (settlement.status === "completed" || settlement.status === "submitted") {
          return { settlement: serializeSettlement(settlement) };
        }

        // A previously-failed settlement can be retried with a new signed
        // XDR (and a new idempotency key).  Reset the retry bookkeeping so
        // the worker process picks it up fresh.
        if (settlement.status === "failed") {
          await auditTx(tx, {
            userId: auth.id,
            action: "settlement.confirm.retry",
            entityType: "settlement",
            entityId: id,
            metadata: { previousFailure: settlement.failureReason },
          });
        }

        // Guard the transition with a conditional update: only rows that
        // are still in a confirmable status ("pending" or "failed") are
        // moved to "submitted".  If a concurrent request already moved
        // the settlement off a confirmable status between the read above
        // and here, the update affects zero rows and we re-read the
        // winning state instead of clobbering it.
        const { count } = await tx.settlement.updateMany({
          where: { id, status: { in: ["pending", "failed"] } },
          data: {
            transactionXdr: body.signedXdr,
            status: "submitted",
            retryCount: 0,
            failureReason: null,
          },
        });

        if (count > 0) {
          await recordStatusTransitionInTransaction(tx, {
            entityType: "settlement",
            entityId: id,
            newStatus: "submitted",
            source: "api",
          });
        }

        const finalSettlement = await tx.settlement.findUniqueOrThrow({
          where: { id },
          include: settlementInclude,
        });

        if (count > 0) {
          await auditTx(tx, {
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
    const { cursor, limit } = paginationQuerySchema.parse(req.query ?? {});
    await requireMembership(groupId, auth.id);

    let decodedCursor = null;
    if (cursor) {
      decodedCursor = decodeCursor(cursor);
      if (!decodedCursor) {
        throw Errors.badRequest("invalid_cursor", "The provided cursor is invalid");
      }
    }

    const cursorFilter = decodedCursor
      ? {
          OR: [
            { createdAt: { lt: decodedCursor.createdAt } },
            {
              createdAt: decodedCursor.createdAt,
              id: { lt: decodedCursor.id },
            },
          ],
        }
      : {};

    const takeCount = limit + 1;

    const [expenses, settlements, treasuryTxs] = await Promise.all([
      prisma.expense.findMany({
        where: { groupId, ...cursorFilter },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: takeCount,
      }),
      prisma.settlement.findMany({
        where: { groupId, ...cursorFilter },
        include: { from: true, to: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: takeCount,
      }),
      prisma.treasuryTransaction.findMany({
        where: { groupId, ...cursorFilter },
        include: { user: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: takeCount,
      }),
    ]);

    const entries = [
      ...expenses.slice(0, query.limit).map((e) => ({
        type: "expense" as const,
        createdAt: e.createdAt,
        id: e.id,
        expense: serializeExpense(e),
      })),
      ...settlements.slice(0, query.limit).map((s) => ({
        type: "settlement" as const,
        createdAt: s.createdAt,
        id: s.id,
        settlement: serializeSettlement(s),
      })),
      ...treasuryTxs.slice(0, query.limit).map((t) => ({
        type: "treasury" as const,
        createdAt: t.createdAt,
        id: t.id,
        treasuryTransaction: serializeTreasuryTx(t),
      })),
    ].sort((a, b) => {
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      return a.id < b.id ? 1 : -1;
    });

    const hasMore = entries.length > limit;
    const results = hasMore ? entries.slice(0, limit) : entries;
    const nextCursor = hasMore
      ? encodeCursor(
          results[results.length - 1].createdAt,
          results[results.length - 1].id
        )
      : null;

    return {
      entries: results.map((r) => {
        const { id, ...rest } = r;
        return {
          ...rest,
          createdAt: r.createdAt.toISOString(),
        };
      }),
      meta: { nextCursor, hasMore },
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
