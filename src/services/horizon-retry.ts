/**
 * Bounded retry wrapper for Horizon and other Stellar network calls.
 *
 * Horizon is a distributed service that can return transient errors (rate
 * limits, connection resets, timeouts) without the underlying transaction
 * being rejected. A naive retry loop would resubmit blindly, but this module
 * classifies each failure before deciding whether to retry:
 *
 *  - **transient** (rate limit, 5xx, connection reset): retry with backoff
 *  - **indeterminate** (timeout, socket hangup): the caller must check the
 *    ledger before resubmitting — this module retries the *same* call (e.g.
 *    getTransaction) but never blindly resubmits a payment
 *  - **permanent** (4xx validation, rejected transaction): fail immediately
 *
 * All retries are bounded by `maxAttempts` and the delay uses exponential
 * backoff with jitter so a fleet recovering from the same outage does not
 * thunder-herd.
 */

import { TimeoutError, TransportError } from "./timeout";

// ─── Retry policy ───────────────────────────────────────────────────────────

export interface HorizonRetryPolicy {
  /** Total attempts, including the first. */
  maxAttempts: number;
  /** Base delay in ms for the first retry. */
  initialDelayMs: number;
  /** Maximum delay cap in ms. */
  maxDelayMs: number;
  /** Fraction of delay applied as random jitter (0–1). */
  jitterRatio: number;
}

/** Default policy for Horizon read/write calls. */
export const HORIZON_RETRY_POLICY: HorizonRetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  jitterRatio: 0.3,
};

// ─── Error classification ───────────────────────────────────────────────────

export type HorizonErrorCategory = "transient" | "indeterminate" | "permanent";

/**
 * Classify a Horizon call error for retry decisions.
 *
 * This is more specific than `classifyJobFailure` in job-retry.ts: it uses
 * the typed error classes (`TimeoutError`, `TransportError`) from timeout.ts
 * and Horizon-specific result codes rather than message-string matching.
 */
export function classifyHorizonError(error: unknown): HorizonErrorCategory {
  // Typed errors from our timeout wrapper.
  if (error instanceof TimeoutError) return "indeterminate";
  if (error instanceof TransportError) return "transient";

  // AppError from the API layer — read the status code.
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = (error as { statusCode: number }).statusCode;
    if (status === 429) return "transient";
    if (status >= 500) return "transient";
    if (status >= 400) return "permanent";
  }

  // Horizon SDK error shapes — the response body may carry result_codes.
  const response = extractResponse(error);
  if (response) {
    const resultCodes = response.extras?.result_codes;
    if (resultCodes) {
      const txCode = resultCodes.transaction_result_code;
      // These Stellar transaction codes are permanent — the transaction
      // itself is invalid and retrying with the same envelope won't help.
      const permanentTxCodes = [
        "tx_bad_auth",
        "tx_bad_seq",
        "tx_insufficient_fee",
        "tx_too_late",
        "tx_too_early",
        "tx_malformed",
        "tx_not_supported",
        "tx_failed",
      ];
      if (txCode && permanentTxCodes.includes(txCode)) return "permanent";

      // Operation-level errors may be transient (e.g. underfunded can happen
      // when a concurrent payment consumed the balance).
      const opCodes = resultCodes.operations ?? [];
      const permanentOpCodes = [
        "op_no_destination",
        "op_no_trust",
        "op_not_authorized",
        "op_line_full",
        "op_underfunded",
        "op_src_no_trust",
        "op_src_not_authorized",
      ];
      if (opCodes.some((code: string) => permanentOpCodes.includes(code))) {
        return "permanent";
      }
    }

    // HTTP status on the Horizon response itself.
    if (typeof response.status === "number") {
      if (response.status === 429) return "transient";
      if (response.status >= 500) return "transient";
      if (response.status >= 400) return "permanent";
    }
  }

  // Fallback: treat as transient to allow one more attempt, but the bounded
  // retry count ensures this never spins indefinitely.
  return "transient";
}

function extractResponse(
  error: unknown
): { status?: number; extras?: { result_codes?: any } } | null {
  if (!error || typeof error !== "object") return null;
  const e = error as any;
  // Horizon SDK wraps errors in e.response.data
  if (e.response?.data) return e.response.data;
  // Direct Horizon error shape
  if (e.data) return e.data;
  return null;
}

// ─── Backoff calculation ────────────────────────────────────────────────────

/**
 * Exponential backoff with jitter for an attempt number (1-based).
 *
 * The delay doubles each attempt (capped at `maxDelayMs`) and a random
 * jitter of ±`jitterRatio` is applied so a fleet of workers does not
 * retry in lockstep.
 */
export function horizonRetryDelayMs(
  attempt: number,
  policy: HorizonRetryPolicy = HORIZON_RETRY_POLICY,
  random: () => number = Math.random
): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  const base = Math.min(
    policy.maxDelayMs,
    policy.initialDelayMs * 2 ** exponent
  );
  const jitter = base * policy.jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

// ─── Retry wrapper ──────────────────────────────────────────────────────────

/**
 * Result of a retried operation, distinguishing success from exhausted retries.
 */
export interface RetryResult<T> {
  ok: true;
  value: T;
}

export interface RetryExhausted {
  ok: false;
  lastError: unknown;
  attempts: number;
}

export type HorizonRetryOutcome<T> = RetryResult<T> | RetryExhausted;

/**
 * Whether the outcome represents a successful result.
 */
export function isRetrySuccess<T>(
  outcome: HorizonRetryOutcome<T>
): outcome is RetryResult<T> {
  return outcome.ok;
}

/**
 * Run an async operation with bounded retries, exponential backoff, and
 * transient-error classification.
 *
 * The `classify` function receives each error and decides whether to retry:
 *  - `"transient"` → retry with delay
 *  - `"indeterminate"` → retry with delay (caller must reconcile after)
 *  - `"permanent"` → fail immediately
 *
 * The `beforeRetry` callback is invoked between retries so the caller can
 * perform ledger checks or other reconciliation before the next attempt.
 *
 * @param fn - The operation to run. Called up to `policy.maxAttempts` times.
 * @param classify - Error classifier. Defaults to `classifyHorizonError`.
 * @param policy - Retry policy. Defaults to `HORIZON_RETRY_POLICY`.
 * @param beforeRetry - Optional hook called before each retry with the error
 *   and attempt number. Return `false` to abort without retrying.
 * @param delay - Injectable delay for testing.
 */
export async function withHorizonRetry<T>(
  fn: () => Promise<T>,
  options: {
    classify?: (error: unknown) => HorizonErrorCategory;
    policy?: HorizonRetryPolicy;
    beforeRetry?: (error: unknown, attempt: number) => Promise<boolean | void>;
    delay?: (ms: number) => Promise<void>;
  } = {}
): Promise<HorizonRetryOutcome<T>> {
  const {
    classify = classifyHorizonError,
    policy = HORIZON_RETRY_POLICY,
    beforeRetry,
    delay = defaultDelay,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (error) {
      lastError = error;
      const category = classify(error);

      // Permanent failures stop immediately.
      if (category === "permanent") {
        return { ok: false, lastError: error, attempts: attempt };
      }

      // If this was the last attempt, stop.
      if (attempt >= policy.maxAttempts) {
        return { ok: false, lastError: error, attempts: attempt };
      }

      // Let the caller reconcile before the next retry (e.g. check the
      // ledger before resubmitting a payment).
      if (beforeRetry) {
        const shouldContinue = await beforeRetry(error, attempt);
        if (shouldContinue === false) {
          return { ok: false, lastError: error, attempts: attempt };
        }
      }

      // Backoff with jitter.
      const delayMs = horizonRetryDelayMs(attempt, policy);
      await delay(delayMs);
    }
  }

  return { ok: false, lastError, attempts: policy.maxAttempts };
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
