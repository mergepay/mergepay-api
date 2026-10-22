/**
 * Canonical type definitions for the SEP-24 anchor transaction lifecycle.
 *
 * This module is the single source of truth for the raw SEP-24 deposit and
 * withdrawal statuses Mergepay understands. Before it existed the list was
 * written out by hand in more than one place — `anchor.ts`'s
 * `KNOWN_SEP24_STATUSES`, `anchor-status.ts`'s `ANCHOR_SESSION_STATUSES`, and
 * the JWT callback handler's `RECOGNISED_STATUSES` — and those copies had
 * already drifted (the latter recognised the deprecated `pending_external`,
 * the former did not). Every layer now derives from the types below, so a
 * status cannot be known to one and unknown to another.
 *
 * The API contract these types describe is mirrored in
 * `mergepay-web/src/lib/types.ts`; keep the two in sync (see CONTRIBUTING.md).
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md#transaction-history
 */

/** Which side of the anchor flow a transaction represents. */
export type Sep24TransactionKind = "deposit" | "withdrawal";

/**
 * The SEP-24 transaction statuses Mergepay supports.
 *
 * Deliberately a closed union rather than `string`: an anchor cannot add a
 * status that silently widens what Mergepay will accept, and the exhaustive
 * `Record<Sep24TransactionStatus, ...>` tables below stop compiling the moment
 * a member is added without being classified.
 *
 * A status we do not recognise is still handled gracefully at the edges
 * (`mapAnchorStatus` collapses it to `pending_anchor`), but it is never a
 * *member* of this union.
 */
export type Sep24TransactionStatus =
  // Initial
  | "incomplete"
  // Intermediate — requires or awaits action
  | "pending_user_transfer_start"
  | "pending_user"
  | "pending_transaction_info_update"
  | "pending_receiver"
  | "pending_sender"
  | "pending_stellar"
  | "pending_trust"
  | "pending_anchor"
  // Terminal
  | "completed"
  | "error"
  | "refunded"
  | "expired"
  | "no_market"
  | "too_small"
  | "too_large";

/** Runtime mirror of {@link Sep24TransactionStatus}, in documented order. */
export const SEP24_TRANSACTION_STATUSES: readonly Sep24TransactionStatus[] = [
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
 * Deprecated SEP-24 statuses that anchors in the wild still emit. They are not
 * part of {@link Sep24TransactionStatus} — historically the SEP-24 spec used
 * `pending_external` (now split into `pending_sender` / `pending_receiver`) and
 * `pending_user_transfer_complete` (now folded into `pending_anchor`).
 *
 * Callbacks carrying one of these are recognised rather than logged as
 * unknown, and normalize to `pending_anchor` via the safe-default branch in
 * `mapAnchorStatus` — matching Mergepay's long-standing behaviour.
 */
export const SEP24_LEGACY_STATUSES: readonly string[] = [
  "pending_user_transfer_complete",
  "pending_external",
];

/** Set form of {@link SEP24_TRANSACTION_STATUSES}. */
export const KNOWN_SEP24_STATUSES: ReadonlySet<Sep24TransactionStatus> = new Set(
  SEP24_TRANSACTION_STATUSES
);

// ─── Lifecycle categories ───────────────────────────────────────────────────

/**
 * Coarse phase a status belongs to. Callers that only need "is this still in
 * flight?" (workers deciding whether to poll, the UI choosing a spinner) can
 * branch on the category instead of enumerating statuses.
 */
export type Sep24StatusCategory = "initial" | "intermediate" | "terminal";

export const SEP24_INITIAL_STATUSES: readonly Sep24TransactionStatus[] = [
  "incomplete",
];

export const SEP24_INTERMEDIATE_STATUSES: readonly Sep24TransactionStatus[] = [
  "pending_user_transfer_start",
  "pending_user",
  "pending_transaction_info_update",
  "pending_receiver",
  "pending_sender",
  "pending_stellar",
  "pending_trust",
  "pending_anchor",
];

export const SEP24_TERMINAL_STATUSES: readonly Sep24TransactionStatus[] = [
  "completed",
  "error",
  "refunded",
  "expired",
  "no_market",
  "too_small",
  "too_large",
];

/**
 * Every status mapped to its category. Typed as an exhaustive `Record` so TS
 * fails the build if a new status is added to the union without a category —
 * the compile-time guard against the drift this module exists to prevent.
 */
export const SEP24_STATUS_CATEGORY: Record<
  Sep24TransactionStatus,
  Sep24StatusCategory
> = {
  incomplete: "initial",
  pending_user_transfer_start: "intermediate",
  pending_user: "intermediate",
  pending_transaction_info_update: "intermediate",
  pending_receiver: "intermediate",
  pending_sender: "intermediate",
  pending_stellar: "intermediate",
  pending_trust: "intermediate",
  pending_anchor: "intermediate",
  completed: "terminal",
  error: "terminal",
  refunded: "terminal",
  expired: "terminal",
  no_market: "terminal",
  too_small: "terminal",
  too_large: "terminal",
};

// ─── Type guards ────────────────────────────────────────────────────────────

/**
 * Whether a raw status string is a supported SEP-24 status. Case-insensitive
 * and whitespace-tolerant; the predicate narrows `string` to
 * {@link Sep24TransactionStatus}.
 */
export function isSep24TransactionStatus(
  raw: string
): raw is Sep24TransactionStatus {
  if (!raw) return false;
  return (KNOWN_SEP24_STATUSES as ReadonlySet<string>).has(
    raw.trim().toLowerCase()
  );
}

/**
 * Whether a raw status is recognised at all — a supported status or one of the
 * deprecated aliases in {@link SEP24_LEGACY_STATUSES}. Used by callback
 * handlers to decide whether an unrecognised status deserves a warning.
 */
export function isRecognisedSep24Status(raw: string): boolean {
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return (
    (KNOWN_SEP24_STATUSES as ReadonlySet<string>).has(normalized) ||
    SEP24_LEGACY_STATUSES.includes(normalized)
  );
}

export function isTerminalSep24Status(status: string): boolean {
  return (SEP24_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function isIntermediateSep24Status(status: string): boolean {
  return (SEP24_INTERMEDIATE_STATUSES as readonly string[]).includes(status);
}

export function isInitialSep24Status(status: string): boolean {
  return (SEP24_INITIAL_STATUSES as readonly string[]).includes(status);
}

/** Category for a status. Exhaustive by construction. */
export function sep24StatusCategory(
  status: Sep24TransactionStatus
): Sep24StatusCategory {
  return SEP24_STATUS_CATEGORY[status];
}

// ─── Deposit / withdrawal transaction state views ───────────────────────────

/**
 * The status-bearing slice of a SEP-24 anchor transaction, as the API exposes
 * it to the client. `category` and `terminal` are derived from `status` so a
 * consumer never has to re-derive the lifecycle rules.
 */
export interface Sep24TransactionState {
  status: Sep24TransactionStatus;
  category: Sep24StatusCategory;
  /** True once the transaction can no longer advance (any terminal status). */
  terminal: boolean;
}

/** State view of a deposit (on-ramp) transaction. */
export interface Sep24DepositTransaction extends Sep24TransactionState {
  kind: "deposit";
}

/** State view of a withdrawal (off-ramp) transaction. */
export interface Sep24WithdrawalTransaction extends Sep24TransactionState {
  kind: "withdrawal";
}

/** Discriminated union over the two SEP-24 flow directions. */
export type Sep24Transaction =
  | Sep24DepositTransaction
  | Sep24WithdrawalTransaction;

/**
 * Build the typed state view for a status. The `kind` overloads return the
 * concrete deposit/withdrawal shape, so a caller that passes `"deposit"`
 * cannot treat the result as a withdrawal.
 */
export function sep24TransactionState(
  kind: "deposit",
  status: Sep24TransactionStatus
): Sep24DepositTransaction;
export function sep24TransactionState(
  kind: "withdrawal",
  status: Sep24TransactionStatus
): Sep24WithdrawalTransaction;
export function sep24TransactionState(
  kind: Sep24TransactionKind,
  status: Sep24TransactionStatus
): Sep24Transaction {
  return {
    kind,
    status,
    category: SEP24_STATUS_CATEGORY[status],
    terminal: isTerminalSep24Status(status),
  };
}
