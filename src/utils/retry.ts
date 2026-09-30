/**
 * Reusable retry utility with exponential backoff and jitter for Horizon RPC calls,
 * ledger queries, and transaction submission checks.
 *
 * Network hiccups or Horizon rate limits (HTTP 429) can cause transaction submission
 * checks or ledger queries to fail intermittently. This module provides a robust,
 * generic retry helper that safely retries idempotent operations with bounded
 * exponential backoff, preventing infinite loops while smoothing over transient failures.
 */

import { TimeoutError, TransportError } from "../services/timeout";

/**
 * Options for configuring retry with exponential backoff.
 */
export interface RetryOptions {
  /**
   * Total number of attempts, including the initial attempt.
   * Defaults to 3.
   */
  maxAttempts?: number;

  /**
   * Initial delay in milliseconds before the first retry attempt.
   * Defaults to 1000ms.
   */
  initialDelayMs?: number;

  /**
   * Maximum ceiling / cap on any single backoff delay in milliseconds.
   * Defaults to 15000ms.
   */
  maxDelayMs?: number;

  /**
   * Multiplier applied to the backoff delay on each subsequent attempt.
   * Defaults to 2 (doubling delay).
   */
  backoffFactor?: number;

  /**
   * Whether to apply randomized jitter to prevent synchronized retries across nodes.
   * Defaults to true.
   */
  jitter?: boolean;

  /**
   * Maximum fraction of the delay that may be removed as jitter (0 to 1).
   * Defaults to 0.25.
   */
  jitterRatio?: number;

  /**
   * Predicate that determines whether a caught error is transient and safe to retry.
   * Defaults to {@link isTransientHorizonError}.
   */
  isRetryable?: (error: unknown) => boolean;

  /**
   * Optional callback invoked before each retry with the error, attempt number that failed,
   * and the computed delay in milliseconds.
   */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;

  /**
   * Custom sleep function for delays. Injectable for deterministic, instant unit tests.
   * Defaults to setTimeout-based async sleep.
   */
  sleep?: (ms: number) => Promise<void>;

  /**
   * Random source in `[0, 1)` for jitter calculation. Injectable for testing.
   * Defaults to Math.random.
   */
  random?: () => number;
}

/**
 * Default sleep implementation using setTimeout.
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Calculate the exponential backoff delay in milliseconds before a given attempt.
 *
 * - Attempt 1 has no delay (0ms) as it is the initial execution.
 * - Attempt 2 waits `initialDelayMs`.
 * - Subsequent attempts double (or multiply by `backoffFactor`) the delay,
 *   capped at `maxDelayMs`.
 * - Optional jitter is subtracted from the computed delay.
 *
 * @param attempt - 1-based attempt number about to be executed (2 for first retry).
 * @param options - Configuration options for backoff timing.
 * @param random - Random generator in `[0, 1)` for jitter testing.
 * @returns Delay in milliseconds, never negative.
 */
export function calculateBackoffDelay(
  attempt: number,
  options: {
    initialDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    jitter?: boolean;
    jitterRatio?: number;
  } = {},
  random: () => number = Math.random
): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return 0;

  const initialDelayMs = Math.max(0, options.initialDelayMs ?? 1000);
  const maxDelayMs = Math.max(initialDelayMs, options.maxDelayMs ?? 15000);
  const backoffFactor = Math.max(1, options.backoffFactor ?? 2);
  const jitter = options.jitter ?? true;
  const jitterRatio = Math.max(0, Math.min(1, options.jitterRatio ?? 0.25));

  const exponent = attempt - 2;
  const exponential = initialDelayMs * Math.pow(backoffFactor, exponent);
  const capped = Math.min(exponential, maxDelayMs);

  if (!jitter || jitterRatio <= 0) {
    return Math.max(0, Math.round(capped));
  }

  const jitterAmount = capped * jitterRatio * random();
  return Math.max(0, Math.round(capped - jitterAmount));
}

/**
 * Horizon transaction and operation result codes that indicate permanent rejection.
 * Retrying with the same envelope or parameters will never succeed.
 */
const PERMANENT_HORIZON_CODES = new Set([
  "tx_bad_auth",
  "tx_bad_seq",
  "tx_insufficient_fee",
  "tx_too_late",
  "tx_too_early",
  "tx_malformed",
  "tx_not_supported",
  "tx_failed",
  "op_no_destination",
  "op_no_trust",
  "op_not_authorized",
  "op_line_full",
  "op_underfunded",
  "op_src_no_trust",
  "op_src_not_authorized",
]);

/**
 * Inspect an error to extract HTTP status code if present.
 */
function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const e = error as {
    response?: { status?: number; data?: { status?: number } };
    status?: number;
    statusCode?: number;
    cause?: unknown;
  };
  const status =
    e.response?.status ??
    e.status ??
    e.statusCode ??
    e.response?.data?.status;
  if (typeof status === "number") return status;
  if (e.cause && typeof e.cause === "object") {
    return extractHttpStatus(e.cause);
  }
  return null;
}

/**
 * Extract Horizon result codes from response data if available.
 */
function extractHorizonCodes(error: unknown): string[] {
  if (!error || typeof error !== "object") return [];
  const e = error as any;
  const data = e.response?.data ?? e.data;
  const extras = data?.extras?.result_codes ?? data?.result_codes;
  if (!extras) return [];

  const codes: string[] = [];
  if (typeof extras.transaction === "string") codes.push(extras.transaction);
  if (typeof extras.transaction_result_code === "string") {
    codes.push(extras.transaction_result_code);
  }
  if (Array.isArray(extras.operations)) {
    for (const op of extras.operations) {
      if (typeof op === "string") codes.push(op);
    }
  }
  if (Array.isArray(extras.operation_results)) {
    for (const op of extras.operation_results) {
      if (typeof op === "string") codes.push(op);
    }
  }
  return codes;
}

/**
 * Determine if an error encountered during a Horizon RPC call or ledger query
 * is transient (and therefore safe and suitable to retry).
 *
 * Transient failures include:
 *  - HTTP 429 Too Many Requests (rate limiting)
 *  - HTTP 408 Request Timeout
 *  - HTTP 5xx Server Errors (500, 502, 503, 504), excluding 501 / 505
 *  - Network timeouts (TimeoutError, ETIMEDOUT)
 *  - Transport disruptions (TransportError, ECONNRESET, ECONNREFUSED, socket hang up)
 *
 * Permanent / terminal failures that are NOT retried:
 *  - HTTP 4xx Client Errors (400 Bad Request, 401 Unauthorized, 403 Forbidden,
 *    404 Not Found, 409 Conflict, 422 Unprocessable Entity)
 *  - Non-retryable HTTP 501 (Not Implemented) and 505 (HTTP Version Not Supported)
 *  - Horizon rejection codes (tx_bad_auth, tx_bad_seq, op_no_trust, etc.)
 *
 * @param error - The error thrown by the operation.
 * @returns `true` if the failure is transient and can be retried; `false` otherwise.
 */
export function isTransientHorizonError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  // Typed errors from the service layer
  if (error instanceof TimeoutError) return true;
  if (error instanceof TransportError) {
    const underlyingStatus = extractHttpStatus(error);
    if (underlyingStatus !== null) {
      return isTransientStatus(underlyingStatus);
    }
    return true;
  }

  // Horizon result codes check: permanent transaction/operation errors should not be retried
  const horizonCodes = extractHorizonCodes(error);
  if (horizonCodes.some((code) => PERMANENT_HORIZON_CODES.has(code))) {
    return false;
  }

  // Check HTTP status code
  const status = extractHttpStatus(error);
  if (status !== null) {
    return isTransientStatus(status);
  }

  // Check network error codes and messages
  const err = error as { code?: string; message?: string; name?: string };
  const networkCodes = new Set([
    "ECONNRESET",
    "ETIMEDOUT",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "EPIPE",
  ]);
  if (err.code && networkCodes.has(err.code)) {
    return true;
  }

  if (err.name === "AbortError" || err.name === "FetchError") {
    return true;
  }

  const msg = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (
    msg.includes("socket hang up") ||
    msg.includes("network error") ||
    msg.includes("connection reset") ||
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("timed out") ||
    msg.includes("timeout") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("failed to fetch")
  ) {
    return true;
  }

  // Unrecognized errors without a 4xx status are treated as transient up to maxAttempts
  return true;
}

function isTransientStatus(status: number): boolean {
  if (status === 429) return true;
  if (status === 408) return true;
  if (status === 501 || status === 505) return false;
  if (status >= 500) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/**
 * Execute an asynchronous operation with retry logic and exponential backoff.
 *
 * Only transient failures (rate limits, 5xx, network drops) are retried;
 * terminal client errors (4xx, permanent Stellar transaction errors) fail immediately.
 * Retries are strictly bounded by `maxAttempts` and `maxDelayMs` to avoid infinite loops.
 *
 * @param fn - The operation to execute. Receives the 1-based attempt number.
 * @param options - Configurable retry policy, error filter, and timing overrides.
 * @returns Whatever `fn` resolves to on the first successful attempt.
 * @throws The error from the final attempt once retries are exhausted, or the
 *   non-retryable error immediately on terminal failure.
 */
export async function retryWithBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts = 3,
    initialDelayMs = 1000,
    maxDelayMs = 15000,
    backoffFactor = 2,
    jitter = true,
    jitterRatio = 0.25,
    isRetryable = isTransientHorizonError,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;

      // Terminal errors fail immediately without wasting retry attempts
      if (!isRetryable(error)) {
        throw error;
      }

      // If budget is exhausted, throw without sleeping
      if (attempt >= maxAttempts) {
        throw error;
      }

      const delayMs = calculateBackoffDelay(
        attempt + 1,
        { initialDelayMs, maxDelayMs, backoffFactor, jitter, jitterRatio },
        random
      );

      onRetry?.(error, attempt, delayMs);

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

/** Aliases for convenience */
export {
  retryWithBackoff as withRetryBackoff,
  isTransientHorizonError as isRetryableHorizonError,
};
