/**
 * Centralized, auditable state transition model for SEP-24 anchor sessions
 * (deposits and withdrawals).
 *
 * Anchor callbacks and polling can arrive out of order or be delivered more
 * than once, so every status change funnels through this module rather than
 * being applied ad hoc by routes or the worker. It guarantees:
 *
 *   - Only transitions in the finite map below are ever applied.
 *   - Repeated delivery of the same status is a no-op (idempotent).
 *   - Regressions from a terminal state, or any transition not explicitly
 *     allowed, are ignored rather than applied or thrown as an error —
 *     anchor callbacks are untrusted input and out-of-order delivery is
 *     expected, not exceptional.
 *   - Every *applied* transition writes its audit record in the same
 *     database transaction as the status change itself, so a caller can
 *     never observe a status change without its audit entry.
 *   - When a caller supplies the `expectedStatus` it read earlier, the status
 *     change is applied with a conditional update, so a stale writer can
 *     never land a write on top of a state it did not actually observe.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { auditTx } from "./audit";
import { Errors } from "../errors";

export type AnchorSessionStatus =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_user"
  | "pending_transaction_info_update"
  | "pending_receiver"
  | "pending_sender"
  | "pending_stellar"
  | "pending_trust"
  | "pending_anchor"
  | "completed"
  | "error"
  | "refunded"
  | "expired"
  | "no_market"
  | "too_small"
  | "too_large";

export type AnchorTransitionSource = "user" | "webhook" | "poll";

/** The full set of statuses Mergepay tracks for an anchor session. */
export const ANCHOR_SESSION_STATUSES: readonly AnchorSessionStatus[] = [
  "incomplete",
  "pending_user_transfer_start",
  "pending_user",
  "pending_transaction_info_update",
  "pending_receiver",
  "pending_sender",
  "pending_stellar",
  "pending_trust",
  "pending_anchor",
  "completed",
  "error",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
];

/**
 * Documented finite transition map. `completed` and `refunded` are terminal:
 * no further transition is ever applied once reached. `error` may still
 * resolve to `refunded` (anchors commonly refund after a failed transfer),
 * but never regresses back to a pending state.
 *
 * The map is the single authoritative boundary for how raw SEP-24 statuses
 * (already normalized by `mapAnchorStatus` in src/services/anchor.ts) become
 * local state. `mapAnchorStatus` funnels every known terminal failure
 * (expired/no_market/too_small/too_large) into `error`, so only the local
 * states below ever flow through this map.
 */
const ALLOWED_TRANSITIONS: Record<AnchorSessionStatus, readonly AnchorSessionStatus[]> = {
  incomplete: [
    "pending_user_transfer_start", "pending_user", "pending_transaction_info_update",
    "pending_receiver", "pending_sender", "pending_stellar", "pending_trust", "pending_anchor",
    "error", "expired", "no_market", "too_small", "too_large",
  ],
  pending_user_transfer_start: [
    "pending_user", "pending_transaction_info_update", "pending_receiver", "pending_sender",
    "pending_stellar", "pending_trust", "pending_anchor", "error", "refunded", "completed",
    "expired", "no_market", "too_small", "too_large",
  ],
  pending_user: [
    "pending_transaction_info_update", "pending_receiver", "pending_sender", "pending_stellar",
    "pending_trust", "pending_anchor", "error", "refunded", "completed", "expired", "no_market",
    "too_small", "too_large",
  ],
  pending_transaction_info_update: [
    "pending_user", "pending_receiver", "pending_sender", "pending_stellar", "pending_trust",
    "pending_anchor", "error", "refunded", "completed", "expired", "no_market", "too_small", "too_large",
  ],
  pending_receiver: [
    "pending_user", "pending_transaction_info_update", "pending_sender", "pending_stellar", "pending_trust",
    "pending_anchor", "error", "refunded", "completed", "expired", "no_market", "too_small", "too_large",
  ],
  pending_sender: [
    "pending_user", "pending_transaction_info_update", "pending_receiver", "pending_stellar", "pending_trust",
    "pending_anchor", "error", "refunded", "completed", "expired", "no_market", "too_small", "too_large",
  ],
  pending_stellar: [
    "pending_user", "pending_transaction_info_update", "pending_receiver", "pending_sender", "pending_trust",
    "pending_anchor", "error", "refunded", "completed", "expired", "no_market", "too_small", "too_large",
  ],
  pending_trust: [
    "pending_user", "pending_transaction_info_update", "pending_receiver", "pending_sender", "pending_stellar",
    "pending_anchor", "error", "refunded", "completed", "expired", "no_market", "too_small", "too_large",
  ],
  pending_anchor: [
    "pending_user", "pending_transaction_info_update", "pending_receiver", "pending_sender", "pending_stellar",
    "pending_trust", "error", "refunded", "completed", "expired", "no_market", "too_small", "too_large",
  ],
  completed: [],
  error: ["refunded"],
  refunded: [],
  expired: [],
  no_market: [],
  too_small: [],
  too_large: [],
};

/**
 * A local anchor status is terminal once it can no longer regress. We treat
 * `error` as terminal for the purposes of stale-write protection (it may only
 * still advance to `refunded`), along with `completed` and `refunded`. This is
 * kept consistent with the SEP-24 terminal set in src/services/anchor.ts.
 */
export function isTerminalAnchorStatus(status: string): boolean {
  return [
    "completed", "error", "refunded", "expired", "no_market", "too_small", "too_large",
  ].includes(status);
}

export function canTransitionAnchorStatus(
  from: AnchorSessionStatus,
  to: AnchorSessionStatus
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

function isKnownStatus(status: string): status is AnchorSessionStatus {
  return (ANCHOR_SESSION_STATUSES as readonly string[]).includes(status);
}

export interface AnchorSessionUpdateResult<T> {
  session: T;
  /** Whether the status (or extra data) actually changed. */
  changed: boolean;
}

/**
 * Apply a validated status transition (and optionally other session fields)
 * to a single anchor session, atomically with its audit record.
 *
 * `nextStatus` should already be normalized via `mapAnchorStatus` — this
 * function only decides whether the transition is *allowed*, not how to
 * interpret a raw anchor status string.
 *
 * Pass `expectedCurrentStatus` when the caller holds a snapshot of the session
 * (e.g. a poll cycle that read the row earlier). The transition is then
 * applied with a conditional update that requires the row to *still* be in
 * that status; if a concurrent writer already advanced it, the update is a
 * no-op and `changed` is false — a stale writer can never land on top of a
 * terminal state it did not observe.
 */
export async function applyAnchorSessionTransition(params: {
  sessionId: string;
  nextStatus: string;
  source: AnchorTransitionSource;
  /** Fields to persist alongside a successful transition (e.g. interactiveUrl). */
  extraData?: Prisma.AnchorSessionUncheckedUpdateInput;
  /** When set, the caller must own this session (throws 403/404 otherwise). */
  ownerUserId?: string;
  /** An optional stale-write guard: the status the caller last observed. */
  expectedCurrentStatus?: string;
}): Promise<AnchorSessionUpdateResult<{ id: string; status: string }>> {
  const { sessionId, nextStatus, source, extraData, ownerUserId, expectedCurrentStatus } = params;

  return prisma.$transaction(async (tx) => {
    const session = await tx.anchorSession.findUnique({ where: { id: sessionId } });
    if (!session) {
      throw Errors.notFound("Anchor session not found");
    }
    if (ownerUserId !== undefined && session.userId !== ownerUserId) {
      throw Errors.forbidden("You do not have access to this anchor session");
    }

    const current = session.status as AnchorSessionStatus;
    const target = isKnownStatus(nextStatus) ? nextStatus : "pending_anchor";

    // Idempotent duplicate delivery of the same status: still persist any
    // accompanying extra data (e.g. a retried "complete" call resending the
    // same interactive URL), but never re-transition or re-audit.
    if (target === current) {
      if (extraData) {
        const updated = await tx.anchorSession.update({
          where: { id: sessionId },
          data: extraData,
        });
        return { session: updated, changed: false };
      }
      return { session, changed: false };
    }

    // Invalid regression (including any attempt to leave a terminal state):
    // ignored without changing the record or writing an audit entry.
    if (!canTransitionAnchorStatus(current, target)) {
      return { session, changed: false };
    }

    // A stale-write guard: the caller's snapshot must still be the live
    // status, otherwise a concurrent (e.g. terminal) write already won and
    // this transition must not land. Guarding before the update makes the
    // monotonic guarantee explicit at the database layer rather than only in
    // this process's memory.
    if (expectedCurrentStatus !== undefined && expectedCurrentStatus !== current) {
      return { session, changed: false };
    }
    if (expectedCurrentStatus !== undefined) {
      const { count } = await tx.anchorSession.updateMany({
        where: { id: sessionId, status: expectedCurrentStatus },
        data: { ...extraData, status: target },
      });
      if (count === 0) {
        // The row moved underneath us — a concurrent (e.g. terminal) write won.
        return { session, changed: false };
      }
      await auditTx(tx, {
        userId: session.userId,
        action: "anchor_session.status_changed",
        entityType: "anchor_session",
        entityId: sessionId,
        metadata: { from: current, to: target, source },
      });
      // updateMany cannot return the updated row; synthesise the minimal shape
      // the transition contract requires. StatusHistory/audit reflect the new
      // state; callers needing the full row read the record themselves.
      const merged = {
        ...session,
        ...(extraData as Record<string, unknown> | undefined),
        status: target,
      };
      return { session: merged, changed: true };
    }

    const updated = await tx.anchorSession.update({
      where: { id: sessionId },
      data: { ...extraData, status: target },
    });

    await auditTx(tx, {
      userId: session.userId,
      action: "anchor_session.status_changed",
      entityType: "anchor_session",
      entityId: sessionId,
      metadata: { from: current, to: target, source },
    });

    return { session: updated, changed: true };
  });
}
