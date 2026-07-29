import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { stellar } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit, AuditAction } from "../services/audit";
import { normalizeAmount } from "../services/money";
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
import { stellarAmountSchema, refineStellarAsset } from "../lib/stellar-validation";
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  hashIdempotentRequest,
} from "../lib/idempotency";

const settlementInclude = { from: true, to: true } as const;

export default async function settlementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- settle a specific expense share ----------------------------------------
  app.post("/expenses/:id/settle", async (req, reply) => {
    const auth = requireUser(req);
    const { id: expenseId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        assetCode: z.string().min(1).max(12).optional(),
        assetIssuer: z.string().nullable().optional(),
      })
      .superRefine((val, ctx) => {
        // assetCode omitted means "use the expense's own asset" — already validated at creation.
        if (val.assetCode !== undefined) refineStellarAsset(ctx, val.assetCode, val.assetIssuer);
      })
      .parse(req.body ?? {});

    // Everything below reads or mutates state, so it all runs behind the
    // idempotency claim — a replay short-circuits before touching the DB.
    return withIdempotency(
      req,
      reply,
      `settlement.create.expense:${expenseId}`,
      auth.id,
      body,
      async () => {
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

        const code = shortCode();

        // Build the XDR first — it's read-only/local (no DB or Stellar
        // writes), so if it throws (e.g. unfunded account) nothing durable
        // has happened yet and the idempotency key is safe to free for retry.
        const xdr = await buildSettlementXdr({
          fromPublicKey: auth.stellarPublicKey,
          toPublicKey: expense.payer.stellarPublicKey,
          assetCode,
          assetIssuer,
          amount: myShare.shareAmount.toString(),
          memoCode: code,
        });

        const settlement = await prisma.$transaction(async (tx) => {
          const created = await tx.settlement.create({
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

          await audit(
            {
              actor: { type: "user", userId: auth.id },
              action: AuditAction.SettlementCreate,
              entityType: "settlement",
              entityId: created.id,
              metadata: {
                groupId: expense.groupId,
                expenseId: expense.id,
                amount: myShare.shareAmount.toString(),
                assetCode,
              },
            },
            tx
          );

          return created;
        });

        return {
          settlement: serializeSettlement(settlement),
          xdr,
          networkPassphrase: config.networkPassphrase,
        };
      }
    );
  });

  // -- freeform settle-up against net balance ---------------------------------
  app.post("/groups/:id/settlements", async (req, reply) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        toUserId: z.string(),
        amount: stellarAmountSchema,
        assetCode: z.string().min(1).max(12),
        assetIssuer: z.string().nullable().optional(),
      })
      .superRefine((val, ctx) => refineStellarAsset(ctx, val.assetCode, val.assetIssuer))
      .parse(req.body);

    // Everything below reads or mutates state, so it all runs behind the
    // idempotency claim — a replay short-circuits before touching the DB.
    return withIdempotency(
      req,
      reply,
      `settlement.create.group:${groupId}`,
      auth.id,
      body,
      async () => {
        await requireMembership(groupId, auth.id);

        if (body.toUserId === auth.id) {
          throw Errors.badRequest("self_settle", "You cannot settle with yourself");
        }
        const recipient = await prisma.groupMember.findUnique({
          where: { groupId_userId: { groupId, userId: body.toUserId } },
          include: { user: true },
        });
        if (!recipient) throw Errors.badRequest("invalid_recipient", "Recipient is not a member");

        const amount = normalizeAmount(body.amount);
        const code = shortCode();

        // Same ordering rationale as /expenses/:id/settle: build (no side
        // effects) before persisting, so a failure here leaves nothing to
        // reconcile and the idempotency key can be freed for retry.
        const xdr = await buildSettlementXdr({
          fromPublicKey: auth.stellarPublicKey,
          toPublicKey: recipient.user.stellarPublicKey,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          amount,
          memoCode: code,
        });

        const settlement = await prisma.$transaction(async (tx) => {
          const created = await tx.settlement.create({
            data: {
              shortCode: code,
              groupId,
              fromUserId: auth.id,
              toUserId: body.toUserId,
              amount,
              assetCode: body.assetCode,
              assetIssuer: body.assetIssuer ?? null,
              status: "pending",
              memo: memoText(code),
            },
            include: settlementInclude,
          });
          await audit(
            {
              actor: { type: "user", userId: auth.id },
              action: AuditAction.SettlementCreate,
              entityType: "settlement",
              entityId: created.id,
              metadata: { groupId, toUserId: body.toUserId, amount, assetCode: body.assetCode },
            },
            tx
          );
          return created;
        });

        return {
          settlement: serializeSettlement(settlement),
          xdr,
          networkPassphrase: config.networkPassphrase,
        };
      }
    );
  });

  // -- confirm (submit signed xdr) --------------------------------------------
  app.post("/settlements/:id/confirm", async (req, reply) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);

    return withIdempotency(
      req,
      reply,
      `settlement.confirm:${id}`,
      auth.id,
      body,
      async () => {
        const settlement = await prisma.settlement.findUnique({
          where: { id },
          include: { from: true, to: true },
        });
        if (!settlement) throw Errors.notFound("Settlement not found");
        if (settlement.fromUserId !== auth.id) {
          throw Errors.forbidden("Only the payer can confirm this settlement");
        }

        // Already past "pending" (confirmed, submitted, or failed) — this is
        // a redundant confirm, not a fresh state change. Return the current
        // state without mutating or resubmitting anything.
        if (settlement.status !== "pending") {
          await audit({
            actor: { type: "user", userId: auth.id },
            action: AuditAction.SettlementConfirmDuplicate,
            entityType: "settlement",
            entityId: id,
            outcome: "duplicate",
            metadata: { status: settlement.status },
          });
          return { settlement: serializeSettlement(settlement) };
        }

        const updated = await prisma.$transaction(async (tx) => {
          const saved = await tx.settlement.update({
            where: { id },
            data: {
              transactionXdr: body.signedXdr,
              status: "submitted",
            },
            include: settlementInclude,
          });
          await audit(
            {
              actor: { type: "user", userId: auth.id },
              action: AuditAction.SettlementConfirm,
              entityType: "settlement",
              entityId: id,
              metadata: { status: "submitted" },
            },
            tx
          );
          return saved;
        });

        return { settlement: serializeSettlement(updated) };
      }
    );
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

/**
 * Runs `run()` guarded by the request's `Idempotency-Key` header, if present.
 * The key is claimed (a durable row, unique-constraint-serialized against
 * concurrent callers) before `run()` executes, so two racing requests with
 * the same key can never both create a settlement or submit a payment.
 * Without a header, this is a no-op passthrough — idempotency stays opt-in.
 */
async function withIdempotency<T>(
  req: FastifyRequest,
  reply: FastifyReply,
  scope: string,
  userId: string,
  body: unknown,
  run: () => Promise<T>
) {
  const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
  if (!idempotencyKey) return run();

  const requestHash = hashIdempotentRequest({ userId, scope, body });
  const outcome = await claimIdempotencyKey({ key: idempotencyKey, userId, requestHash });

  if (outcome.kind === "replay") {
    return reply.code(outcome.statusCode).send(outcome.body);
  }
  if (outcome.kind === "in_progress") {
    return reply.code(409).send({
      error: "idempotency_in_progress",
      message: "A request with this idempotency key is already being processed",
      statusCode: 409,
      requestId: req.id as string,
    });
  }
  if (outcome.kind === "conflict") {
    return reply.code(409).send({
      error: "idempotency_conflict",
      message: "Idempotency key was already used with a different user or request body",
      statusCode: 409,
      requestId: req.id as string,
    });
  }

  try {
    const result = await run();
    await completeIdempotencyKey(idempotencyKey, 200, result);
    return result;
  } catch (err) {
    // Nothing durable happened under this key yet (see call sites — the
    // side-effecting mutation always follows any side-effect-free I/O in
    // `run()`), so it's safe to free the key for an unambiguous retry.
    await failIdempotencyKey(idempotencyKey);
    throw err;
  }
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
