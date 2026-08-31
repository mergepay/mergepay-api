/**
 * Centralized, auditable state transition model for SEP-24 `Withdrawal`
 * records (the simpler, user-facing record created by `POST /withdraw` —
 * see the doc comment on the `Withdrawal` model in schema.prisma).
 *
 * Anchor callbacks and client retries can arrive out of order or be
 * delivered more than once, so every status change funnels through this
 * module rather than being applied ad hoc by routes. It guarantees:
 *
 *   - Only transitions in the finite map below are ever applied.
 *   - Repeated delivery of the same status is a no-op (idempotent).
 *   - Regressions from a terminal state, or any transition not explicitly
 *     allowed, are ignored rather than applied or thrown as an error —
 *     anchor callbacks are untrusted input and out-of-order delivery is
 *     expected, not exceptional. (Same documented policy as
 *     applyAnchorSessionTransition in ./anchor-status.ts — kept consistent
 *     on purpose.)
 *   - `completed` can only be reached via a `webhook` or `poll` source —
 *     i.e. only once the anchor itself has reported the transfer complete.
 *     The client-facing confirm route can drive a withdrawal to
 *     `processing`, never straight to `completed`; this is what "never mark
 *     a transaction complete before the corresponding asset movement is
 *     confirmed" means for a record that has no internal settlement ledger
 *     of its own (unlike `Settlement`, a `Withdrawal`'s "settlement" *is*
 *     the anchor's own completion report).
 *   - Every *applied* transition writes its audit record in the same
 *     database transaction as the status change itself, so a caller can
 *     never observe a status change without its audit entry.
 *   - The status change itself is written with a guarded/conditional
 *     update (`updateMany` with the previously-read status in the WHERE
 *     clause), not a blind `update`. Two near-simultaneous duplicate
 *     transitions can both pass the in-memory transition check, but only
 *     one can ever match that WHERE clause — the loser sees `count: 0` and
 *     is treated as a lost race (a no-op), so a race can never produce two
 *     audit rows for the same transition.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { auditTx } from "./audit";
import { Errors } from "../errors";

export type WithdrawalStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "refunded";

export type WithdrawalTransitionSource = "user" | "webhook" | "poll";

/** The full set of statuses Mergepay tracks for a withdrawal. */
export const WITHDRAWAL_STATUSES: readonly WithdrawalStatus[] = [
  "pending",
  "processing",
  "completed",
  "failed",
  "expired",
  "refunded",
];

/**
 * Documented finite transition map. `completed`, `failed`, `expired`, and
 * `refunded` are terminal: no further transition is ever applied once
 * reached.
 */
const ALLOWED_TRANSITIONS: Record<WithdrawalStatus, readonly WithdrawalStatus[]> = {
  pending: ["processing", "failed", "expired"],
  processing: ["completed", "failed", "expired", "refunded"],
  completed: [],
  failed: [],
  expired: [],
  refunded: [],
};

export function isTerminalWithdrawalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "expired" ||
    status === "refunded"
  );
}

export function canTransitionWithdrawalStatus(
  from: WithdrawalStatus,
  to: WithdrawalStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

function isKnownStatus(status: string): status is WithdrawalStatus {
  return (WITHDRAWAL_STATUSES as readonly string[]).includes(status);
}

/**
 * Map a raw SEP-24 anchor status (already normalized by
 * `mapAnchorStatus` in ./anchor.ts) to Mergepay's `Withdrawal` status
 * vocabulary. This is a deliberate, documented collapse — not a silent
 * fallback — of the anchor's many intermediate statuses into a single
 * `processing` bucket, since `Withdrawal` (unlike `AnchorSession`) is a
 * simple record the frontend polls for a coarse status, not a detailed
 * per-step timeline.
 */
export function mapAnchorStatusToWithdrawalStatus(anchorStatus: string): WithdrawalStatus {
  switch (anchorStatus) {
    case "completed":
      return "completed";
    case "refunded":
      return "refunded";
    case "expired":
      return "expired";
    case "error":
    case "no_market":
    case "too_small":
    case "too_large":
      return "failed";
    // Every other known-or-unknown intermediate anchor status (incomplete,
    // pending_user_transfer_start, pending_anchor, pending_stellar,
    // pending_trust, pending_user, pending_transaction_info_update,
    // pending_receiver, pending_sender, and anything the anchor introduces
    // in the future) is still in flight from Mergepay's point of view.
    default:
      return "processing";
  }
}

export interface WithdrawalTransitionResult<T> {
  withdrawal: T;
  /** Whether the status (or extra data) actually changed. */
  changed: boolean;
}

/**
 * Apply a validated status transition (and optionally other withdrawal
 * fields) to a single withdrawal, atomically with its audit record.
 *
 * `nextStatus` should already be normalized via `mapAnchorStatusToWithdrawalStatus`
 * when the source is an anchor observation — this function only decides
 * whether the transition is *allowed*, not how to interpret a raw anchor
 * status string.
 */
export async function applyWithdrawalTransition(params: {
  withdrawalId: string;
  nextStatus: string;
  source: WithdrawalTransitionSource;
  /** Fields to persist alongside a successful transition (e.g. anchorTxId). */
  extraData?: Prisma.WithdrawalUncheckedUpdateInput;
  /** When set, the caller must own this withdrawal (throws 403/404 otherwise). */
  ownerUserId?: string;
}): Promise<WithdrawalTransitionResult<{ id: string; status: string }>> {
  const { withdrawalId, nextStatus, source, extraData, ownerUserId } = params;

  return prisma.$transaction(async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
    if (!withdrawal) {
      throw Errors.notFound("Withdrawal not found");
    }
    if (ownerUserId !== undefined && withdrawal.userId !== ownerUserId) {
      throw Errors.forbidden("You do not have access to this withdrawal");
    }

    const current = withdrawal.status as WithdrawalStatus;
    const target = isKnownStatus(nextStatus) ? nextStatus : "processing";

    // Idempotent duplicate delivery of the same status: still persist any
    // accompanying extra data (e.g. a retried confirm resending the same
    // anchorTxId), but never re-transition or re-audit.
    if (target === current) {
      if (extraData) {
        const updated = await tx.withdrawal.update({
          where: { id: withdrawalId },
          data: extraData,
        });
        return { withdrawal: updated, changed: false };
      }
      return { withdrawal, changed: false };
    }

    // Invalid regression (including any attempt to leave a terminal state):
    // ignored without changing the record or writing an audit entry.
    if (!canTransitionWithdrawalStatus(current, target)) {
      return { withdrawal, changed: false };
    }

    // `completed` may only be applied when the anchor itself reported it
    // (webhook or poll) — never as a direct consequence of the user-facing
    // confirm route. This is the explicit gate on "asset movement confirmed
    // before completion" for a record with no internal settlement ledger.
    if (target === "completed" && source === "user") {
      return { withdrawal, changed: false };
    }

    // Guarded/conditional update: the WHERE clause re-checks `status`
    // against what we just read, so a concurrent duplicate transition can
    // only ever win the write once.
    const { count } = await tx.withdrawal.updateMany({
      where: { id: withdrawalId, status: current },
      data: { ...extraData, status: target },
    });
    if (count === 0) {
      // Lost the race to a concurrent transition — treat like any other
      // no-op duplicate rather than raising.
      const latest = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });
      return { withdrawal: latest ?? withdrawal, changed: false };
    }

    const updated = await tx.withdrawal.findUnique({ where: { id: withdrawalId } });

    await auditTx(tx, {
      userId: withdrawal.userId,
      action: "withdrawal.status_changed",
      entityType: "withdrawal",
      entityId: withdrawalId,
      metadata: { from: current, to: target, source },
    });

    return { withdrawal: updated ?? withdrawal, changed: true };
  });
}
