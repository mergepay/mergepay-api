/**
 * Settlement failure classification.
 *
 * ## Why this exists
 *
 * A failed settlement used to be diagnosable only from the logs. The row
 * recorded a free-text `failureReason`, which is fine for an operator reading
 * one record and useless for a client that needs to decide what to *do*: retry,
 * top up a balance, ask for a fresh envelope, or wait out an outage.
 *
 * This module maps every failure to one of a small, stable set of categories.
 * The category is what clients and operators branch on; the sanitized detail is
 * the human-readable half, and neither ever carries secret material.
 *
 * ## Why one module
 *
 * Both the request path (`POST /settlements/:id/confirm`) and the worker can
 * drive a settlement to a terminal failure. Classifying in two places means
 * they drift, and the same underlying failure gets reported two different ways
 * depending on which process happened to observe it. Everything that records a
 * settlement failure calls `classifySettlementFailure`.
 *
 * ## What is never persisted or returned
 *
 * No signed or unsigned XDR, no bearer token or anchor session token, no
 * provider credentials, no raw upstream response body, and no stack trace. The
 * detail is produced by `safeFailureMessage` (see src/services/job-retry.ts),
 * which scrubs those patterns, and is then length-capped. `redactFailureDetail`
 * adds the settlement-specific patterns on top: a bare XDR blob and a bare
 * Stellar secret seed, neither of which is a labelled `key=value` pair that a
 * generic scrubber would catch.
 */

import { AppError } from "../errors";
import { safeFailureMessage } from "./job-retry";

/**
 * The stable set of failure categories.
 *
 * Deliberately small. Each names something a client can act on differently:
 *
 *   validation          the request or envelope was wrong (bad XDR, intent
 *                       mismatch, authorization). A retry of the same input
 *                       fails the same way; the fix is a corrected request.
 *   insufficient_funds  the payer cannot cover the payment, the fee, or the
 *                       reserve, or lacks the trustline. The fix is funding.
 *   expired             the signing window closed before submission. The fix is
 *                       a new settlement, never a retry of this one.
 *   upstream            Horizon or an anchor was unreachable, timed out, or
 *                       rate-limited. Nothing is wrong with the request.
 *   ledger_rejected     the network itself rejected the transaction, or it
 *                       failed on-chain. Permanent for this envelope.
 *   internal            an unclassified failure inside the API.
 */
export const SETTLEMENT_FAILURE_CATEGORIES = [
  "validation",
  "insufficient_funds",
  "expired",
  "upstream",
  "ledger_rejected",
  "internal",
] as const;

export type SettlementFailureCategory =
  (typeof SETTLEMENT_FAILURE_CATEGORIES)[number];

/** Whether a persisted string is one of the known categories. */
export function isSettlementFailureCategory(
  value: unknown
): value is SettlementFailureCategory {
  return (
    typeof value === "string" &&
    (SETTLEMENT_FAILURE_CATEGORIES as readonly string[]).includes(value)
  );
}

export interface SettlementFailure {
  category: SettlementFailureCategory;
  /** Sanitized, length-capped, client-safe explanation. */
  detail: string;
}

/** Longest detail persisted or returned. Matches the job-retry reason cap. */
export const MAX_FAILURE_DETAIL_LENGTH = 300;

/**
 * Error codes that name their own category, checked before any message text.
 *
 * Classifying on a stable code rather than provider wording is what keeps this
 * from breaking when Horizon rephrases an error.
 */
const CODE_CATEGORIES: Record<string, SettlementFailureCategory> = {
  INTENT_EXPIRED: "expired",
  XDR_MISMATCH: "validation",
  XDR_MALFORMED: "validation",
  XDR_UNSIGNED: "validation",
  VALIDATION_ERROR: "validation",
  BAD_REQUEST: "validation",
  UNAUTHORIZED: "validation",
  FORBIDDEN: "validation",
  ACCOUNT_UNFUNDED: "insufficient_funds",
  MISSING_TRUSTLINE: "insufficient_funds",
  INSUFFICIENT_BALANCE: "insufficient_funds",
  INSUFFICIENT_FEE_BALANCE: "insufficient_funds",
  RATE_LIMITED: "upstream",
  UPSTREAM_ERROR: "upstream",
  INTERNAL_ERROR: "internal",
};

/**
 * Stellar result codes and message fragments, checked in a fixed order.
 *
 * Order matters where a single message can match more than one family: an
 * expired envelope reads as `tx_too_late`, which is both an expiry and a ledger
 * rejection, and expiry is the more useful answer because it names the remedy.
 */
const MESSAGE_RULES: ReadonlyArray<{
  category: SettlementFailureCategory;
  markers: readonly string[];
}> = [
  {
    category: "expired",
    markers: ["tx_too_late", "intent_expired", "expired", "signing window"],
  },
  {
    category: "insufficient_funds",
    markers: [
      "op_underfunded",
      "underfunded",
      "tx_insufficient_balance",
      "insufficient balance",
      "insufficient funds",
      "op_no_trust",
      "op_src_no_trust",
      "no trustline",
      "trustline",
      "op_line_full",
      "not enough",
      "tx_insufficient_fee",
      "op_low_reserve",
      "reserve",
    ],
  },
  {
    category: "upstream",
    markers: [
      "timeout",
      "timed out",
      "rate limit",
      "rate_limit",
      "too many requests",
      "service unavailable",
      "temporarily unavailable",
      "bad gateway",
      "gateway timeout",
      "econnrefused",
      "econnreset",
      "enotfound",
      "socket hang up",
      "network",
      "could not reach",
      "unreachable",
    ],
  },
  {
    category: "validation",
    markers: [
      "xdr_mismatch",
      "malformed",
      "does not match",
      "signature",
      "tx_bad_auth",
      "unauthoriz",
      "forbidden",
      "op_no_destination",
      "op_not_authorized",
      "op_src_not_authorized",
      "invalid",
    ],
  },
  {
    category: "ledger_rejected",
    markers: [
      "rejected the transaction",
      "failed on stellar",
      "tx_failed",
      "tx_bad_seq",
      "tx_too_early",
      "tx_no_source_account",
      "tx_missing_operation",
      "op_",
      "tx_",
    ],
  },
];

/**
 * A bare Stellar secret seed: 'S' plus 55 base32 characters.
 *
 * `safeFailureMessage` scrubs labelled secrets (`secret=…`), but a seed pasted
 * into an error message on its own carries no label to match.
 */
const BARE_SECRET_SEED = /\bS[A-Z2-7]{55}\b/g;

/**
 * A bare base64 blob long enough to be a transaction envelope.
 *
 * An unlabelled XDR would otherwise survive into a persisted detail. The bound
 * is deliberately high so ordinary error text, hashes, and public keys are left
 * alone — the shortest real payment envelope is well past it.
 */
const BARE_XDR_BLOB = /\b[A-Za-z0-9+/]{120,}={0,2}/g;

/**
 * Scrub what a generic sanitizer cannot see: unlabelled secret material.
 *
 * Applied on top of `safeFailureMessage`, never instead of it.
 */
export function redactFailureDetail(message: string): string {
  return message
    .replace(BARE_SECRET_SEED, "[redacted]")
    .replace(BARE_XDR_BLOB, "[redacted]");
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error ?? "");
}

/**
 * Classify a settlement failure into a stable category and a safe detail.
 *
 * Consulted in order: an `AppError`'s own code, then its status class, then
 * message text. Codes and statuses are structural and survive rewording;
 * message matching is the fallback for errors thrown by the SDK or Horizon.
 */
export function classifySettlementFailure(error: unknown): SettlementFailure {
  const detail = toSafeDetail(error);

  if (error instanceof AppError) {
    const byCode = CODE_CATEGORIES[error.code];
    if (byCode) return { category: byCode, detail };

    // A code we do not name explicitly still has a meaningful status class.
    if (error.status === 429 || error.status >= 500) {
      return { category: "upstream", detail };
    }
    if (error.status >= 400 && error.status < 500) {
      return { category: "validation", detail };
    }
  }

  // Timeouts and transport failures are typed, so they are recognised without
  // depending on how the message happens to read.
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "TransportError") {
    return { category: "upstream", detail };
  }

  const haystack = messageOf(error).toLowerCase();
  for (const rule of MESSAGE_RULES) {
    if (rule.markers.some((marker) => haystack.includes(marker))) {
      return { category: rule.category, detail };
    }
  }

  return { category: "internal", detail };
}

/**
 * Produce the persisted detail for an error: scrubbed by the shared job-retry
 * sanitizer, then by the settlement-specific patterns, then length-capped.
 *
 * Exported so a caller recording a failure it classified elsewhere still gets
 * an identically sanitized detail.
 */
export function toSafeDetail(
  error: unknown,
  maxLength = MAX_FAILURE_DETAIL_LENGTH
): string {
  const scrubbed = redactFailureDetail(safeFailureMessage(error, maxLength));
  const trimmed = scrubbed.trim().slice(0, maxLength);
  return trimmed.length > 0 ? trimmed : "Settlement failed";
}

/**
 * Build the failure fields to persist alongside a terminal `failed` status.
 *
 * Returned as a plain object so the caller can fold it into the same update or
 * transaction that writes the status — the failure and the state it explains
 * are recorded together, never as two writes that can diverge.
 */
export function settlementFailureFields(error: unknown): {
  failureCategory: SettlementFailureCategory;
  failureReason: string;
} {
  const { category, detail } = classifySettlementFailure(error);
  return { failureCategory: category, failureReason: detail };
}
