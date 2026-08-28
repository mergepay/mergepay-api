/**
 * Settlement routes.
 *
 * Two shapes of write live here and both are idempotent (see
 * src/services/idempotency.ts):
 *
 *  - **creation** (`POST /expenses/:id/settle`, `POST /groups/:id/settlements`)
 *    mints a settlement record and returns an *unsigned* XDR for the wallet to
 *    sign. `Idempotency-Key` is optional but honoured: a retry with the same
 *    key and an equivalent payload returns the original settlement and XDR
 *    instead of creating a second record.
 *  - **submission** (`POST /settlements/:id/confirm`) accepts the wallet's
 *    signed envelope. `Idempotency-Key` is **required** here — this is the
 *    request that leads to money moving, and a retry that slipped through
 *    could mean a second on-chain payment.
 *
 * The API never holds a private key. Everything Horizon-facing lives in
 * src/services/stellar.ts so it can be mocked in tests.
 */
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { stellar, memoText } from "../services/stellar";
import { validateSettlementXdr } from "../services/settlement-xdr";
import { shortCode } from "../services/codes";
import { audit, auditTx } from "../services/audit";
import { rateLimited } from "../lib/rate-limit";
import {
  readIdempotencyKey,
  requireIdempotencyKey,
  runIdempotent,
} from "../services/idempotency";
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
import { refineStellarAsset, stellarAmountSchema } from "../lib/stellar-validation";
import {
  intentExpiry,
  intentValiditySchema,
  secondsUntilExpiry,
} from "../lib/time-bounds";
import {
  isTerminalSettlementStatus,
  resolveSettlementStatus,
  toPublicStatus,
} from "../services/settlement-status";
import { applySettlementTransition } from "../services/settlement-machine";
import { recordStatusTransitionInTransaction } from "../services/status-history";

const settlementInclude = { from: true, to: true, statusHistory: true } as const;

/** Every route in this file takes a single opaque resource id. */
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * A settlement's public identifier: either its cuid or its short code. Both are
 * unique. Constrained to the characters those identifiers actually use, so a
 * malformed path is a validation error before it reaches the database.
 */
const settlementIdParamSchema = z.object({
  id: z
    .string()
    .min(4)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "Not a valid settlement identifier"),
});

const settlementStatusQuerySchema = z.object({
  /**
   * Whether to consult Horizon for on-chain confirmation. On by default —
   * confirming a payment is the point of the endpoint — but a client rendering
   * a list can pass `refresh=false` to read only persisted state.
   */
  refresh: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

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
        assetCode: z.string().min(1).max(12).optional(),
        assetIssuer: z.string().nullable().optional(),
        // A client may ask for a *shorter* signing window than the default; the
        // schema bounds the request and the server clock decides the deadline.
        validitySeconds: intentValiditySchema.optional(),
      })
      .superRefine((val, ctx) => {
        // assetCode omitted means "use the expense's own asset" — already validated at creation.
        if (val.assetCode !== undefined) refineStellarAsset(ctx, val.assetCode, val.assetIssuer);
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

        // Database-level duplicate guard: even if the request-level idempotency
        // service is bypassed (e.g. no key, or a test double), the unique
        // constraint on (expenseShareId, idempotencyKey) catches duplicates.
        if (idempotencyKey) {
          const existing = await tx.settlement.findFirst({
            where: {
              expenseShareId: myShare.id,
              idempotencyKey,
              status: { notIn: ["failed"] },
            },
            select: { id: true, shortCode: true, status: true },
          });
          if (existing) {
            return {
              settlement: serializeSettlement(existing),
              xdr: null,
              networkPassphrase: config.networkPassphrase,
              duplicate: true,
            };
          }
        }

        const code = shortCode();
        const { expiresAt, validitySeconds } = intentExpiry(body.validitySeconds);
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
            idempotencyKey: idempotencyKey ?? undefined,
            expenseId: expense.id,
            expenseShareId: myShare.id,
            expiresAt,
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
          validitySeconds,
        });

        return {
          settlement: serializeSettlement(settlement),
          xdr,
          networkPassphrase: config.networkPassphrase,
          expiresAt: expiresAt.toISOString(),
          expiresInSeconds: secondsUntilExpiry(expiresAt),
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
        amount: stellarAmountSchema,
        assetCode: z.string().min(1).max(12),
        assetIssuer: z.string().nullable().optional(),
        validitySeconds: intentValiditySchema.optional(),
      })
      .superRefine((val, ctx) => refineStellarAsset(ctx, val.assetCode, val.assetIssuer))
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
        const { expiresAt, validitySeconds } = intentExpiry(body.validitySeconds);
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
            idempotencyKey: idempotencyKey ?? undefined,
            expiresAt,
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
          validitySeconds,
        });

        return {
          settlement: serializeSettlement(settlement),
          xdr,
          networkPassphrase: config.networkPassphrase,
          expiresAt: expiresAt.toISOString(),
          expiresInSeconds: secondsUntilExpiry(expiresAt),
        };
      },
    });
  });

  // -- confirm (submit signed xdr) --------------------------------------------
  app.post("/settlements/:id/confirm", confirmLimit, async (req) => {
    const auth = requireUser(req);
    const { id } = idParamSchema.parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);

    // Required, not optional: this is the request that ends in a payment, and a
    // wallet or mobile client retrying after a timeout must never be able to
    // produce a second submission.
    const idempotencyKey = requireIdempotencyKey(
      req.headers,
      "settlement confirmation"
    );

    // Load the *original* intent and validate the signed envelope against it
    // BEFORE entering the idempotent operation. Two reasons: a validation
    // failure is never recorded as an idempotent success, and a transaction
    // that does not match what the API authorized is rejected before it can be
    // persisted, submitted to Horizon, or advance the settlement's status.
    const settlementRow = await prisma.settlement.findUnique({
      where: { id },
      include: settlementInclude,
    });
    if (!settlementRow) throw Errors.notFound("Settlement not found");
    await requireMembership(settlementRow.groupId, auth.id);
    if (settlementRow.fromUserId !== auth.id) {
      throw Errors.forbidden("Only the payer can confirm this settlement");
    }

    try {
      validateSettlementXdr(body.signedXdr, settlementRow);
    } catch (err) {
      await audit({
        userId: auth.id,
        groupId: settlementRow.groupId,
        action: "settlement.confirm.validation_failed",
        entityType: "settlement",
        entityId: id,
        metadata: {
          // The message is the service's own stable text, never the envelope.
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

        // Already accepted or in-flight — return the current state rather
        // than re-submitting or erroring, so a retry without the original key
        // is still safe. When a transaction hash exists, the worker already
        // submitted to Horizon and is tracking the outcome; the confirm
        // endpoint must not interfere.
        if (
          settlement.status === "completed" ||
          settlement.status === "confirmed" ||
          settlement.status === "submitted" ||
          settlement.status === "verifying" ||
          settlement.status === "needs_review"
        ) {
          // Safe Stellar timeout reconciliation: if the user's confirmation
          // response was lost (network timeout, process crash), the settlement
          // may already be on-chain. Verify the ledger before returning so the
          // client gets an accurate picture rather than a stale "submitted".
          if (settlement.stellarTxHash) {
            try {
              const onChain = await stellar.getTransaction(settlement.stellarTxHash);
              if (onChain?.successful) {
                await applySettlementTransition({
                  settlementId: settlement.id,
                  nextStatus: "confirmed",
                  source: "system",
                  extraData: {
                    retryCount: 0,
                    errorCategory: null,
                    failureReason: null,
                  },
                  settleExpenseShare: true,
                });
                const refreshed = await tx.settlement.findUnique({
                  where: { id },
                  include: settlementInclude,
                });
                return { settlement: serializeSettlement(refreshed!) };
              }
              if (onChain && !onChain.successful) {
                await applySettlementTransition({
                  settlementId: settlement.id,
                  nextStatus: "failed",
                  source: "system",
                  extraData: {
                    failureReason: `Transaction ${settlement.stellarTxHash} failed on Stellar`,
                  },
                });
                const refreshed = await tx.settlement.findUnique({
                  where: { id },
                  include: settlementInclude,
                });
                return { settlement: serializeSettlement(refreshed!) };
              }
            } catch {
              // Horizon unreachable — return persisted state, not an error.
              // The worker's reconciliation will keep watching the hash.
            }
          }
          return { settlement: serializeSettlement(settlement) };
        }

        if (settlement.status === "failed") {
          // A previously-failed settlement can be re-signed and retried. The
          // retry bookkeeping is reset below so the worker picks it up fresh.
          await auditTx(tx, {
            userId: auth.id,
            action: "settlement.confirm.retry",
            entityType: "settlement",
            entityId: id,
            metadata: { previousFailure: settlement.failureReason },
          });
        }

        // Guard the transition with a conditional update: only rows still in a
        // confirmable status are moved to "submitted". If a concurrent request
        // moved the settlement off a confirmable status between the read above
        // and here, this affects zero rows and we return the winning state
        // instead of clobbering it.
        const { count } = await tx.settlement.updateMany({
          where: { id, status: { in: ["pending", "failed"] } },
          data: {
            transactionXdr: body.signedXdr,
            status: "submitted",
            submittedAt: new Date(),
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
          await auditTx(tx, {
            userId: auth.id,
            action: "settlement.confirm",
            entityType: "settlement",
            entityId: id,
            metadata: { status: "submitted" },
          });
        }

        const finalSettlement = await tx.settlement.findUniqueOrThrow({
          where: { id },
          include: settlementInclude,
        });

        return { settlement: serializeSettlement(finalSettlement) };
      },
    });
  });

  // -- status -----------------------------------------------------------------
  //
  // The single source of truth a client polls after creating or signing a
  // settlement, so it never has to infer progress from an unrelated group or
  // expense response.
  //
  // Access: any member of the settlement's group may read it, enforced through
  // the same `requireMembership` helper every mutating route uses — there is no
  // second authorization path here. A settlement that does not exist is a 404;
  // one the caller may not inspect is a 403. That distinction is deliberate
  // (clients need to tell "gone" from "not yours") and leaks only the existence
  // of an opaque identifier, never any amount, party, group, or on-chain detail.
  //
  // The response never includes a signed or unsigned XDR, a token, provider
  // credentials, or upstream error text — see src/services/settlement-status.ts.
  app.get("/settlements/:id/status", async (req) => {
    const auth = requireUser(req);
    const { id } = settlementIdParamSchema.parse(req.params);
    const { refresh } = settlementStatusQuerySchema.parse(req.query ?? {});

    // `id` accepts either the cuid or the human-facing short code, both of
    // which are unique and already public (the short code appears in the
    // payment memo, so a user reading their wallet history can look it up).
    const settlement = await prisma.settlement.findFirst({
      where: { OR: [{ id }, { shortCode: id }] },
      include: settlementInclude,
    });
    if (!settlement) throw Errors.notFound("Settlement not found");

    await requireMembership(settlement.groupId, auth.id);

    // Skipping the provider lookup is opt-in via `refresh=false`, for a client
    // that wants only the persisted state (e.g. rendering a list).
    const resolved = refresh
      ? await resolveSettlementStatus(settlement)
      : {
          status: toPublicStatus(settlement),
          onChain: {
            checked: false,
            found: false,
            successful: null,
            transactionHash: settlement.stellarTxHash ?? null,
          },
          failure: settlement.failureReason
            ? { reason: settlement.failureReason }
            : null,
          expiresAt: settlement.expiresAt
            ? settlement.expiresAt.toISOString()
            : null,
          expiresInSeconds: settlement.expiresAt
            ? secondsUntilExpiry(settlement.expiresAt)
            : null,
          checkedAt: new Date().toISOString(),
        };

    return {
      settlement: serializeSettlement(settlement),
      status: resolved.status,
      terminal: isTerminalSettlementStatus(resolved.status),
      onChain: resolved.onChain,
      failure: resolved.failure,
      expiresAt: resolved.expiresAt,
      expiresInSeconds: resolved.expiresInSeconds,
      createdAt: settlement.createdAt.toISOString(),
      updatedAt: settlement.updatedAt.toISOString(),
      checkedAt: resolved.checkedAt,
    };
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
  validitySeconds: number;
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
    // The envelope's own maxTime and the persisted expiresAt describe the same
    // deadline, so a wallet cannot return something valid longer than the
    // intent it was issued for.
    validitySeconds: params.validitySeconds,
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
