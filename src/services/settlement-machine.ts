import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { AppError, Errors } from "../errors";
import { auditTx } from "./audit";
import { recordStatusTransitionInTransaction } from "./status-history";

export type SettlementStatus =
  | "pending"
  | "submitted"
  | "verifying"
  | "pending_confirmation"
  | "confirmed"
  | "failed"
  | "needs_review";

export type SettlementTransitionSource = "user" | "worker" | "system";

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
      userId: settlement.fromUserId,
      action: "settlement.status_changed",
      entityType: "settlement",
      entityId: settlementId,
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

  if (tx) return execute(tx);
  return prisma.$transaction((client) => execute(client));
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
