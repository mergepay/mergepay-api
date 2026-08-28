/**
 * Retry classification and backoff for background jobs.
 *
 * The worker must be able to answer one question about every failure: *is
 * trying again capable of producing a different result?* Getting this wrong is
 * expensive in both directions — retrying a rejected transaction burns attempts
 * on something that will never succeed, and giving up on a socket hangup leaves
 * a real payment stuck.
 *
 * Three answers, not two:
 *
 *   transient      the call demonstrably did not take effect (rate limit,
 *                  service unavailable, connection refused). Safe to retry.
 *   indeterminate  we never learned the outcome (timeout, dropped socket). The
 *                  transaction may already be on the ledger, so the worker must
 *                  check Horizon by transaction hash *before* resubmitting.
 *   permanent      the request itself is wrong (validation, authorization,
 *                  rejected transaction). Retrying cannot help; the job fails
 *                  and stays visible to operators.
 */

import { config } from "../config";

export type JobFailureCategory = "transient" | "indeterminate" | "permanent";

export interface RetryPolicy {
  /** Total submission attempts, including the first. */
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Fraction of the delay applied as random jitter, 0–1. */
  jitterRatio: number;
}

/**
 * Bounded retry budgets, tunable via environment variables (see
 * src/config.ts). Defaults preserve the pre-configuration behavior.
 */
export const SETTLEMENT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: config.WORKER_SETTLEMENT_MAX_ATTEMPTS,
  initialDelayMs: config.WORKER_SETTLEMENT_RETRY_INITIAL_DELAY_MS,
  maxDelayMs: config.WORKER_SETTLEMENT_RETRY_MAX_DELAY_MS,
  jitterRatio: config.WORKER_SETTLEMENT_RETRY_JITTER_RATIO,
};

export const ANCHOR_RETRY_POLICY: RetryPolicy = {
  maxAttempts: config.WORKER_ANCHOR_MAX_ATTEMPTS,
  initialDelayMs: config.WORKER_ANCHOR_RETRY_INITIAL_DELAY_MS,
  maxDelayMs: config.WORKER_ANCHOR_RETRY_MAX_DELAY_MS,
  jitterRatio: config.WORKER_ANCHOR_RETRY_JITTER_RATIO,
};

/**
 * Exponential backoff for an attempt number (1-based), capped at `maxDelayMs`
 * and jittered so a fleet of workers recovering from the same outage does not
 * resubmit in lockstep.
 */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = SETTLEMENT_RETRY_POLICY,
  random: () => number = Math.random
): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

function statusCodeOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    statusCode?: unknown;
    status?: unknown;
    response?: { status?: unknown };
  };
  const candidate = value.statusCode ?? value.status ?? value.response?.status;
  return typeof candidate === "number" ? candidate : null;
}

const PERMANENT_MARKERS = [
  "invalid",
  "malformed",
  "xdr_mismatch",
  "intent_expired",
  "unauthoriz",
  "unauthenticated",
  "forbidden",
  "not authorized",
  "rejected the transaction",
  "signature",
  "tx_bad_auth",
  "tx_bad_seq",
  "tx_too_late",
  "tx_too_early",
  "tx_insufficient_fee",
  "op_no_destination",
  "op_underfunded",
  "op_no_trust",
  "op_not_authorized",
  "op_line_full",
  "underfunded",
  "trustline",
];

const INDETERMINATE_MARKERS = [
  "timeout",
  "timed out",
  "socket hang up",
  "socket",
  "econnreset",
  "econnaborted",
  "aborted",
  "network",
];

const TRANSIENT_MARKERS = [
  "rate_limit",
  "rate limit",
  "too many requests",
  "service unavailable",
  "temporarily unavailable",
  "temporar",
  "bad gateway",
  "gateway timeout",
  "econnrefused",
  "enotfound",
  "connection refused",
  "stale",
];

/**
 * Classify a job failure. Error *types* and status codes are consulted before
 * message text, so classification does not hinge on provider wording.
 */
export function classifyJobFailure(error: unknown): JobFailureCategory {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError") return "indeterminate";
  if (name === "TransportError") return "transient";

  const status = statusCodeOf(error);
  if (status !== null) {
    if (status === 429) return "transient";
    if (status >= 500) return "transient";
    // A 4xx is the request's own fault; a retry sends the same request.
    if (status >= 400) return "permanent";
  }

  const message = errorMessage(error).toLowerCase();
  if (PERMANENT_MARKERS.some((marker) => message.includes(marker))) return "permanent";
  if (INDETERMINATE_MARKERS.some((marker) => message.includes(marker))) {
    return "indeterminate";
  }
  if (TRANSIENT_MARKERS.some((marker) => message.includes(marker))) return "transient";

  // Unrecognised failures are treated as indeterminate rather than retried
  // blindly: the worker will check the ledger before resubmitting, which is
  // the only safe default for a payment.
  return "indeterminate";
}

/** Whether a category should stop the job rather than schedule another attempt. */
export function isPermanentJobFailure(category: JobFailureCategory): boolean {
  return category === "permanent";
}

/** Extract a provider transaction hash without logging the surrounding error. */
export function failureTransactionHash(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    hash?: unknown;
    response?: { data?: { hash?: unknown; transaction_hash?: unknown } };
  };
  const candidate =
    value.hash ??
    value.response?.data?.hash ??
    value.response?.data?.transaction_hash;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

/**
 * Scrub a failure message before it is persisted or logged.
 *
 * Retry logs are operational breadcrumbs, not payload dumps: bearer tokens,
 * secrets, and signed transaction envelopes must never appear in them.
 */
export function safeFailureMessage(error: unknown, maxLength = 300): string {
  return errorMessage(error)
    .replace(/bearer\s+[a-z0-9._-]+/gi, "bearer [redacted]")
    .replace(
      /(secret|token|password|private[_ -]?key|api[_ -]?key)([=:]\s*)\S+/gi,
      "$1$2[redacted]"
    )
    .replace(/(xdr|envelope|transaction)([=:]\s*)\S+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
