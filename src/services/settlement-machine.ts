import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { AppError, Errors } from "../errors";
import { auditTx, type AuditActorType } from "./audit";
import { AuditAction } from "./audit-actions";
import { recordStatusTransitionInTransaction } from "./status-history";
import { emitEvent, type WebhookEventType } from "./event";

export type SettlementStatus =
  | "pending"
  | "submitted"
  | "verifying"
  | "pending_confirmation"
  | "confirmed"
  | "failed"
  | "needs_review";

export type SettlementTransitionSource = AuditActorType;

/**
 * Map a settlement status transition to its audit action.
 *
 * Only `confirmed` and `failed` have dedicated actions in the issue's
 * vocabulary (SETTLEMENT_CONFIRMED / SETTLEMENT_FAILED) — `verifying` and
 * `needs_review` are internal, non-terminal bookkeeping states with no
 * named action, so they fall back to the generic transition action.
 */
function auditActionForTransition(nextStatus: SettlementStatus): string {
  switch (nextStatus) {
    case "submitted":
      return AuditAction.SETTLEMENT_XDR_SUBMITTED;
    case "confirmed":
      return AuditAction.SETTLEMENT_CONFIRMED;
    case "failed":
      return AuditAction.SETTLEMENT_FAILED;
    default:
      return "settlement.status_changed";
  }
}

export const SETTLEMENT_STATUSES: readonly SettlementStatus[] = [
  "pending",
  "submitted",
  "verifying",
  "pending_confirmation",
  "confirmed",
  "failed",
  "needs_review",
];

const ALLOWED_TRANSITIONS: Record<SettlementStatus, readonly SettlementStatus[]> = {
  pending: ["submitted", "failed"],
  submitted: ["verifying", "failed"],
  verifying: ["confirmed", "failed", "needs_review", "submitted"],
  pending_confirmation: ["confirmed", "failed"],
  confirmed: [],
  failed: [],
  needs_review: ["confirmed", "failed"],
};

export function isTerminalSettlementStatus(status: string): boolean {
  return status === "confirmed" || status === "failed";
}

export function isSettlementRecoverable(status: string): boolean {
  return status === "pending" || status === "submitted" || status === "verifying";
}

export function canTransitionSettlementStatus(
  from: SettlementStatus,
  to: SettlementStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

function isKnownStatus(status: string): status is SettlementStatus {
  return (SETTLEMENT_STATUSES as readonly string[]).includes(status);
}

export interface SettlementTransitionResult<T> {
  settlement: T;
  changed: boolean;
}

export interface ApplySettlementTransitionParams {
  settlementId: string;
  nextStatus: SettlementStatus;
  source: SettlementTransitionSource;
  extraData?: Prisma.SettlementUncheckedUpdateInput;
  ownerUserId?: string;
  tx?: Prisma.TransactionClient;
  /** If true and transitioning to confirmed, also mark the linked expenseShare as settled. */
  settleExpenseShare?: boolean;
}

export async function applySettlementTransition(params: ApplySettlementTransitionParams): Promise<
  SettlementTransitionResult<{ id: string; status: string; expenseShareId: string | null }>
> {
  const {
    settlementId,
    nextStatus,
    source,
    extraData,
    ownerUserId,
    tx,
    settleExpenseShare = false,
  } = params;

  async function execute(client: Prisma.TransactionClient) {
    const settlement = await client.settlement.findUnique({
      where: { id: settlementId },
      select: {
        id: true,
        status: true,
        fromUserId: true,
        expenseShareId: true,
        retryCount: true,
      },
    });
    if (!settlement) {
      throw Errors.notFound("Settlement not found");
    }
    if (ownerUserId !== undefined && settlement.fromUserId !== ownerUserId) {
      throw Errors.forbidden("Only the payer can change this settlement");
    }

    const current = settlement.status as SettlementStatus;

    if (nextStatus === current) {
      if (extraData) {
        const updated = await client.settlement.update({
          where: { id: settlementId },
          data: extraData,
        });
        return { settlement: updated, changed: false };
      }
      return { settlement, changed: false };
    }

    if (!canTransitionSettlementStatus(current, nextStatus)) {
      throw Errors.conflict(
        "invalid_transition",
        `Cannot transition settlement from ${current} to ${nextStatus}`
      );
    }

    const now = new Date();
    const timestamps: Record<string, Date> = {};
    if (nextStatus === "submitted") timestamps.submittedAt = now;
    if (nextStatus === "confirmed") timestamps.confirmedAt = now;

    const allowedFromStatuses = Object.entries(ALLOWED_TRANSITIONS)
      .filter(([, tos]) => tos.includes(nextStatus))
      .map(([from]) => from);

    const updateResult = await client.settlement.updateMany({
      where: {
        id: settlementId,
        status: { in: allowedFromStatuses as SettlementStatus[] },
      },
      data: { ...extraData, ...timestamps, status: nextStatus },
    });

    if (updateResult.count === 0) {
      const currentSettlement = await client.settlement.findUniqueOrThrow({
        where: { id: settlementId },
        select: { id: true, status: true, expenseShareId: true },
      });
      return { settlement: currentSettlement, changed: false };
    }

    const updated = await client.settlement.findUniqueOrThrow({
      where: { id: settlementId },
      select: { id: true, status: true, expenseShareId: true },
    });

    await auditTx(client, {
      // A worker- or system-driven transition (submission, on-chain
      // confirmation, retry exhaustion) is never attributed to the
      // settlement's human payer — that would misrepresent who/what actually
      // acted. Only a user-sourced transition carries a userId.
      userId: source === "user" ? settlement.fromUserId : null,
      actorType: source,
      action: auditActionForTransition(nextStatus),
      entityType: "settlement",
      entityId: settlementId,
      outcome: nextStatus === "failed" ? "failure" : undefined,
      metadata: {
        from: current,
        to: nextStatus,
        source,
        retryCount: settlement.retryCount,
      },
    });

    await recordStatusTransitionInTransaction(client, {
      entityType: "settlement",
      entityId: settlementId,
      newStatus: nextStatus,
      source,
    });

    if (settleExpenseShare && settlement.expenseShareId && nextStatus === "confirmed") {
      await client.expenseShare.update({
        where: { id: settlement.expenseShareId },
        data: { status: "settled" },
      });
    }

    return { settlement: updated, changed: true };
  }

  // The caller owns `tx` and it has not committed yet, so no event is emitted
  // on that path — announcing from inside an open transaction risks telling an
  // integration about a change that is later rolled back.
  if (tx) return execute(tx);

  const result = await prisma.$transaction((client) => execute(client));

  if (result.changed) {
    notifySettlementTransition(settlementId, nextStatus);
  }

  return result;
}

/** Settlement statuses external integrations are told about. */
const NOTIFIED_STATUSES: Partial<Record<SettlementStatus, WebhookEventType>> = {
  confirmed: "settlement.completed",
  failed: "settlement.failed",
};

/**
 * Announce a committed settlement transition on the event bus, which the
 * webhook service turns into queued deliveries.
 *
 * Only terminal outcomes are published. An integration cares that a settlement
 * completed or failed, not that it passed through an intermediate submission
 * state, and publishing every step would spend a receiver's retry budget on
 * transitions it has no action for.
 */
function notifySettlementTransition(
  settlementId: string,
  nextStatus: SettlementStatus
): void {
  const eventType = NOTIFIED_STATUSES[nextStatus];
  if (!eventType) return;

  // Deliberately not awaited: queueing must never turn an already-committed
  // settlement transition into a failed request.
  void (async () => {
    try {
      const row = await prisma.settlement.findUnique({
        where: { id: settlementId },
        select: {
          id: true,
          groupId: true,
          shortCode: true,
          amount: true,
          assetCode: true,
          assetIssuer: true,
          status: true,
          stellarTxHash: true,
          failureReason: true,
        },
      });
      if (!row) return;

      emitEvent({
        eventType,
        groupId: row.groupId,
        payload: {
          settlementId: row.id,
          shortCode: row.shortCode,
          groupId: row.groupId,
          status: row.status,
          amount: String(row.amount),
          assetCode: row.assetCode,
          assetIssuer: row.assetIssuer,
          stellarTxHash: row.stellarTxHash,
          failureReason: row.failureReason,
        },
      });
    } catch {
      // A failed announcement must not surface as a settlement error.
    }
  })();
}

/**
 * Record a settlement's creation. The single call site both settlement
 * creation routes (`POST /expenses/:id/settle` and
 * `POST /groups/:id/settlements`) use, inside the same transaction as the
 * `settlement.create` write, so a settlement can never exist without a
 * corresponding SETTLEMENT_CREATED audit record.
 */
export async function recordSettlementCreated(
  tx: Prisma.TransactionClient,
  params: {
    settlementId: string;
    groupId: string;
    userId: string;
    toUserId: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
  }
): Promise<void> {
  await auditTx(tx, {
    userId: params.userId,
    groupId: params.groupId,
    actorType: "user",
    action: AuditAction.SETTLEMENT_CREATED,
    entityType: "settlement",
    entityId: params.settlementId,
    metadata: {
      toUserId: params.toUserId,
      amount: params.amount,
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
    },
  });
}

/**
 * Accept a wallet-signed envelope for a settlement and move it to
 * `submitted`, atomically with its audit record — the single call site
 * `POST /settlements/:id/confirm` uses.
 *
 * The guard is a conditional `updateMany` (not a read-then-write) so a
 * concurrent request that already moved the settlement off `pending`/`failed`
 * affects zero rows here instead of racing a second submission through; the
 * audit record only fires when this call is the one that actually won the
 * transition (`count > 0`). A retry of a previously-failed settlement is
 * recorded as its own SETTLEMENT_RETRIED event regardless of whether this
 * particular attempt wins the race, since the intent to retry is real even
 * if a concurrent request gets there first.
 */
export async function submitSettlementXdr(params: {
  tx: Prisma.TransactionClient;
  settlementId: string;
  userId: string;
  signedXdr: string;
  currentStatus: string;
  previousFailureReason?: string | null;
}): Promise<{ count: number }> {
  const { tx, settlementId, userId, signedXdr, currentStatus, previousFailureReason } = params;

  if (currentStatus === "failed") {
    await auditTx(tx, {
      userId,
      actorType: "user",
      action: AuditAction.SETTLEMENT_RETRIED,
      entityType: "settlement",
      entityId: settlementId,
      metadata: { previousFailure: previousFailureReason ?? null },
    });
  }

  const { count } = await tx.settlement.updateMany({
    where: { id: settlementId, status: { in: ["pending", "failed"] } },
    data: {
      transactionXdr: signedXdr,
      status: "submitted",
      submittedAt: new Date(),
      retryCount: 0,
      failureReason: null,
    },
  });

  if (count > 0) {
    await recordStatusTransitionInTransaction(tx, {
      entityType: "settlement",
      entityId: settlementId,
      newStatus: "submitted",
      source: "api",
    });
    await auditTx(tx, {
      userId,
      actorType: "user",
      action: AuditAction.SETTLEMENT_XDR_SUBMITTED,
      entityType: "settlement",
      entityId: settlementId,
    });
  }

  return { count };
}

export type ErrorClassification = "transient" | "permanent";

export function classifySettlementError(error: unknown): ErrorClassification {
  if (error instanceof AppError) {
    if (error.statusCode === 429 || error.statusCode >= 500) return "transient";
    if (error.code === "XDR_MISMATCH") return "permanent";
    if (error.statusCode >= 400 && error.statusCode < 500) return "permanent";
    return "transient";
  }

  const message = error instanceof Error ? error.message : String(error);

  const permanentKeywords = [
    "invalid", "malformed", "xdr_mismatch", "unauthorized",
    "forbidden", "not authorized", "bad request", "signature",
    "destination", "op_no_destination", "op_underfunded",
    "op_no_trust", "op_src_no_trust", "op_src_not_authorized",
    "op_not_authorized", "op_line_full", "tx_bad_seq",
    "tx_insufficient_fee", "tx_too_late", "tx_too_early",
  ];

  const lc = message.toLowerCase();
  if (permanentKeywords.some((kw) => lc.includes(kw))) return "permanent";

  const transientKeywords = [
    "timeout", "timed out", "rate_limit", "rate limit",
    "stale", "connection", "network", "temporar",
    "unavailable", "horizon", "retry", "tx_too_soon",
    "tx_insufficient_balance",
  ];
  if (transientKeywords.some((kw) => lc.includes(kw))) return "transient";

  return "transient";
}
