/**
 * Shared timeout and cancellation utilities for external service calls.
 *
 * Provides a consistent way to apply AbortController-based timeouts to
 * fetch calls and other async operations, with typed error classification
 * so callers can distinguish timeout from transport failure from HTTP error.
 */

import { Errors } from "../errors";

// ─── Error types ────────────────────────────────────────────────────────────

/**
 * Thrown when an external operation exceeds its configured deadline.
 * This is a distinct error class so retry logic can classify it as transient.
 */
export class TimeoutError extends Error {
  readonly operation: string;
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super(`Operation "${operation}" timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.operation = operation;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown when a transport-level failure occurs (DNS, connection refused,
 * socket hangup, etc.) that is not a timeout.
 */
export class TransportError extends Error {
  readonly operation: string;
  readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`Transport error in "${operation}": ${message}`);
    this.name = "TransportError";
    this.operation = operation;
    this.cause = cause;
  }
}

// ─── Timeout wrapper ────────────────────────────────────────────────────────

/**
 * Wraps an async operation with a bounded timeout using AbortController.
 *
 * The `signal` is passed to the operation so it can cancel in-flight I/O.
 * If the timeout fires before the operation completes, the operation is
 * rejected with a `TimeoutError`.
 *
 * @param operation - A human-readable label for the operation (used in errors and logs).
 * @param timeoutMs - Maximum time in milliseconds before the operation is aborted.
 * @param fn - The actual async work, receiving the AbortSignal.
 */
export async function withTimeout<T>(
  operation: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(operation, timeoutMs));
    }, timeoutMs);

    fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (err instanceof TimeoutError || err instanceof TransportError) {
          reject(err);
          return;
        }
        if (err instanceof Error && err.name === "AbortError") {
          reject(new TimeoutError(operation, timeoutMs));
          return;
        }
        // Re-throw AppError instances as-is (they are intentional business errors)
        if (err && typeof err === "object" && "statusCode" in err && "code" in err) {
          reject(err);
          return;
        }
        reject(new TransportError(operation, err));
      }
    );
  });
}

/**
 * Wraps a fetch call with a timeout and returns the Response.
 * On timeout, the fetch is aborted and a TimeoutError is thrown.
 * On transport failure, a TransportError is thrown.
 */
export async function fetchWithTimeout(
  url: string,
  operation: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  return withTimeout(operation, timeoutMs, async (signal) => {
    const response = await fetch(url, { ...init, signal });
    return response;
  });
}

// ─── Bounded read retries ───────────────────────────────────────────────────

/**
 * Bounds for retrying a *read-only* external call that failed transiently.
 * These knobs deliberately live by themselves so unsafe writes never inherit
 * them: only operations passed to `retryRead` are retried.
 */
export interface ReadRetryPolicy {
  /** Total attempts including the first. */
  maxAttempts: number;
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Cap on the exponential backoff delay. */
  maxDelayMs: number;
}

/** Delay (ms) before a given retry attempt, capped and lightly jittered. */
export function readRetryDelayMs(
  attempt: number,
  policy: ReadRetryPolicy,
  random: () => number = Math.random
): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
  // ±10% jitter keeps a fleet of processes retrying the same outage from
  // hammering Horizon in lockstep without changing the bound materially.
  const jitter = base * 0.1 * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/**
 * Retry a *read-only* external operation on transient failures.
 *
 * Only a network timeout, a transport failure (DNS, connection refused, socket
 * reset) or an upstream/server error is retried — those are the failures a
 * retry can plausibly outlive. Validation, authentication, and ordinary 4xx
 * responses fail immediately on the first attempt.
 *
 * `submit` MUST NOT be an operation passed to this helper: a second submission
 * could create an unintended duplicate. This helper exists for reads.
 *
 * After the retry budget is exhausted the last original error is re-thrown
 * unchanged, so callers still see the same category (TimeoutError,
 * TransportError, or UPSTREAM_ERROR AppError) they would have without retries.
 */
export async function retryRead<T>(
  operation: string,
  policy: ReadRetryPolicy,
  fn: (attempt: number) => Promise<T>,
  options: {
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { operation: string; attempt: number; maxAttempts: number }) => void;
  } = {}
): Promise<T> {
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const category = classifyExternalError(error);
      const retryable = category === "timeout" || category === "transport" || category === "upstream";
      if (!retryable || attempt >= policy.maxAttempts) {
        throw error;
      }
      options.onRetry?.({ operation, attempt, maxAttempts: policy.maxAttempts });
      await sleep(readRetryDelayMs(attempt, policy));
    }
  }
  throw lastError;
}

/**
 * Classify an error for retry/response logic.
 * Returns "timeout" for TimeoutError, "transport" for TransportError,
 * "upstream" for AppError with UPSTREAM_ERROR code, and "unknown" for
 * everything else.
 */
export function classifyExternalError(
  error: unknown
): "timeout" | "transport" | "upstream" | "unknown" {
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof TransportError) return "transport";
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: string }).code;
    if (code === "UPSTREAM_ERROR") return "upstream";
  }
  return "unknown";
}

/**
 * Convert an external call error to an AppError for API responses.
 * Timeout and transport errors become 502 UPSTREAM_ERROR.
 */
export function toAppError(error: unknown, fallbackMessage: string): ReturnType<typeof Errors.upstream> {
  if (error && typeof error === "object" && "statusCode" in error && "code" in error) {
    return error as ReturnType<typeof Errors.upstream>;
  }
  const message = error instanceof Error ? error.message : String(error);
  return Errors.upstream(`${fallbackMessage}: ${message}`);
}