/**
 * Shared request policy for Horizon and anchor calls.
 *
 * `src/services/timeout.ts` bounds a *single* attempt: past its deadline the
 * call aborts and raises `TimeoutError`. That stops a hung upstream wedging a
 * request or a worker cycle, but it converts every transient blip — a dropped
 * connection, one slow Horizon node, a brief 503 — into a user-visible failure.
 * This module adds the missing half: a bounded number of retries with
 * exponential backoff and jitter, applied only where repeating the call is
 * safe.
 *
 * ## What may be retried
 *
 * **Only reads, or calls whose contract proves retry safety.** Repeating a
 * settlement submission or a treasury transfer can produce a second on-chain
 * payment: Horizon may have applied the transaction and lost the response, in
 * which case the retry is not a retry at all but a duplicate. Those calls keep
 * their single-attempt timeout and are reconciled by the worker, which checks
 * the deterministic transaction hash against Horizon before deciding anything
 * — see `stellar.hashOf` and the settlement reconciliation worker.
 *
 * The rule for future integrations is the one this module encodes:
 *
 *   - A **read** (`GET`-shaped: account load, transaction lookup, fee stats,
 *     anchor toml, anchor transaction status) is retryable. Repeating it
 *     yields the same answer or a fresher one; nothing is created.
 *   - A **write** is retryable only when the upstream itself guarantees
 *     deduplication for the exact request being repeated. Nothing in Horizon's
 *     or SEP-24's contract offers that today, so no write is retried here.
 *   - When in doubt it is not retryable. A missed retry costs one failed
 *     request; a wrong one can cost a duplicate payment.
 *
 * ## What is retried on
 *
 * Only failures that a later attempt could plausibly survive:
 *
 *   - `TimeoutError` / `TransportError` — the request never got an answer.
 *   - HTTP 408 — the upstream timed out waiting; classified as a timeout.
 *   - HTTP 5xx — the upstream failed, not the request — except 501 (Not
 *     Implemented) and 505 (HTTP Version Not Supported), which describe the
 *     request itself and repeat identically.
 *
 * Never retried:
 *
 *   - 4xx other than 408/429 — a validation or authentication failure repeats
 *     identically, so retrying only multiplies load and delays the error the
 *     caller needs to see.
 *   - 429, by default — the upstream is explicitly asking for less traffic.
 *     Retrying into a rate limit is what turns a throttle into an outage, so a
 *     429 is surfaced immediately. A policy may opt in with
 *     `retryRateLimited` (Horizon reads do, see src/services/stellar.ts): the
 *     429 is then retried within the same bounded budget, never sooner than
 *     the upstream's `Retry-After` when it sends one, and not at all when that
 *     `Retry-After` exceeds `maxDelayMs` — a long throttle is surfaced rather
 *     than slept through.
 *
 * ## Backoff
 *
 * Exponential from `initialDelayMs`, capped at `maxDelayMs`, with full jitter
 * in `[delay * (1 - jitterRatio), delay]`. Jitter matters at more than one
 * instance: identical backoff schedules across a fleet reconverge into
 * synchronized bursts against an upstream that is already struggling.
 */
import { config } from "../config";
import { Errors } from "../errors";
import { TimeoutError, TransportError, withTimeout } from "./timeout";

export interface RetryPolicy {
  /** Total attempts, including the first. 1 disables retrying. */
  maxAttempts: number;
  /** Delay before the second attempt, in milliseconds. */
  initialDelayMs: number;
  /** Ceiling for any single backoff delay. */
  maxDelayMs: number;
  /** Fraction of each delay that may be removed as jitter (0–1). */
  jitterRatio: number;
  /**
   * Retry HTTP 429 as well (default `false`). Only for calls where repeating
   * is safe *and* the upstream's limit is shared with nothing that must stay
   * responsive — see the module comment.
   */
  retryRateLimited?: boolean;
}

/** Why an attempt failed, as far as retry policy is concerned. */
export type UpstreamFailureKind =
  | "timeout"
  | "transport"
  | "server_error"
  | "rate_limited"
  | "client_error"
  | "unknown";

/** The default policy for safe Horizon and anchor reads. */
export function defaultReadPolicy(): RetryPolicy {
  return {
    maxAttempts: config.UPSTREAM_RETRY_MAX_ATTEMPTS,
    initialDelayMs: config.UPSTREAM_RETRY_INITIAL_DELAY_MS,
    maxDelayMs: config.UPSTREAM_RETRY_MAX_DELAY_MS,
    jitterRatio: config.UPSTREAM_RETRY_JITTER_RATIO,
  };
}

/** The HTTP status an error carries, if it carries one. */
function statusOf(error: unknown): number | null {
  const candidate = error as {
    response?: { status?: number };
    status?: number;
    statusCode?: number;
  } | null;
  const status =
    candidate?.response?.status ?? candidate?.status ?? candidate?.statusCode;
  return typeof status === "number" ? status : null;
}

/**
 * The error a failure is really about.
 *
 * `withTimeout` wraps anything it does not recognize in a `TransportError`,
 * which is right for a socket hangup but wrong for an SDK error that carries
 * an HTTP status: the Stellar SDK rejects with its own error type, so a 404 or
 * a 400 arrives here already wrapped. Classifying the wrapper would call every
 * one of those a transport blip and retry it — turning "account not funded"
 * into three Horizon calls and a 502. Unwrapping first keeps the status
 * visible to both the classifier and the caller's `isExpected` predicate.
 */
export function unwrapUpstreamError(error: unknown): unknown {
  if (error instanceof TransportError && statusOf(error.cause) !== null) {
    return error.cause;
  }
  return error;
}

/** Classify a failed attempt. */
export function classifyUpstreamFailure(error: unknown): UpstreamFailureKind {
  if (error instanceof TimeoutError) return "timeout";

  const unwrapped = unwrapUpstreamError(error);
  if (unwrapped instanceof TransportError || error instanceof TransportError) {
    // No status underneath: a genuine transport failure.
    if (statusOf(unwrapped) === null) return "transport";
  }

  const status = statusOf(unwrapped);
  if (status === null) return "unknown";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unknown";
}

/**
 * 5xx statuses that describe the request, not a transient upstream fault.
 * They repeat identically, so they are never retried.
 */
const NON_RETRYABLE_SERVER_STATUSES = new Set([501, 505]);

/** The HTTP status behind an attempt's failure, unwrapped from any transport wrapper. */
export function upstreamStatusOf(error: unknown): number | null {
  return statusOf(unwrapUpstreamError(error));
}

/**
 * The upstream's requested wait, in milliseconds, from a `Retry-After`
 * header (delta-seconds or HTTP-date) or an `X-RateLimit-Reset` header
 * (seconds), when the error exposes response headers. `null` when absent or
 * unparseable. The Stellar SDK's own errors do not carry headers, so for
 * Horizon this is best-effort and backoff alone paces the retry.
 */
export function retryAfterMs(error: unknown, now: number = Date.now()): number | null {
  const unwrapped = unwrapUpstreamError(error) as {
    response?: { headers?: unknown };
    headers?: unknown;
  } | null;
  const headers = unwrapped?.response?.headers ?? unwrapped?.headers;
  if (!headers || typeof headers !== "object") return null;

  const read = (name: string): string | null => {
    const h = headers as { get?: (n: string) => unknown } & Record<string, unknown>;
    const value =
      typeof h.get === "function" ? h.get(name) : h[name] ?? h[name.toLowerCase()];
    return typeof value === "string" || typeof value === "number" ? String(value).trim() : null;
  };

  const retryAfter = read("retry-after");
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    // An HTTP-date always names its day/month/zone in letters. Requiring one
    // keeps Date.parse from reading "-5" or "2" as a (year) date.
    if (/[A-Za-z]/.test(retryAfter)) {
      const date = Date.parse(retryAfter);
      if (!Number.isNaN(date)) return Math.max(0, date - now);
    }
  }
  const reset = read("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset)) return Number(reset) * 1000;
  return null;
}

/** Whether one failed attempt should be retried, and after how long. */
export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/**
 * Decide whether the attempt that just failed should be retried.
 *
 * Pure apart from the injected `random` — the whole policy (which failures,
 * how long to wait, when to stop) lives here so it can be tested without
 * timers or network.
 *
 * @param error - The failed attempt's error.
 * @param attempt - 1-based number of the attempt that failed.
 * @param policy - Budget, backoff curve, jitter, and the 429 opt-in.
 * @param random - Jitter source in `[0, 1)`.
 */
export function decideRetry(
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random
): RetryDecision {
  const noRetry = { retry: false, delayMs: 0 };
  if (attempt >= policy.maxAttempts) return noRetry;

  const kind = classifyUpstreamFailure(error);
  const backoff = backoffDelayMs(attempt + 1, policy, random);

  if (kind === "rate_limited") {
    if (!policy.retryRateLimited) return noRetry;
    const requested = retryAfterMs(error);
    if (requested === null) return { retry: true, delayMs: backoff };
    // A throttle longer than the policy is willing to wait is surfaced, not
    // slept through: the caller (or its client) is better placed to wait.
    if (requested > policy.maxDelayMs) return noRetry;
    return { retry: true, delayMs: Math.max(backoff, requested) };
  }

  if (!isRetryableFailure(kind)) return noRetry;
  const status = upstreamStatusOf(error);
  if (status !== null && NON_RETRYABLE_SERVER_STATUSES.has(status)) return noRetry;
  return { retry: true, delayMs: backoff };
}

/**
 * Whether a failure may be retried.
 *
 * `unknown` is deliberately not retryable. An error this module cannot
 * classify is one whose effect on the upstream it cannot reason about, and
 * guessing in the retryable direction is the guess that can duplicate work.
 *
 * Note that `withRetry` rarely sees `unknown` in practice: `withTimeout`
 * normalizes any unrecognized throw from an attempt into a `TransportError`,
 * on the reasoning that an unrecognized failure out of a network call is a
 * transport failure. That normalization is safe precisely because only reads
 * reach this module — the classification is still applied for callers that
 * invoke it directly on an error obtained some other way.
 */
export function isRetryableFailure(kind: UpstreamFailureKind): boolean {
  return kind === "timeout" || kind === "transport" || kind === "server_error";
}

/** Backoff for the delay *before* `attempt` (1-based; attempt 1 has none). */
export function backoffDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random
): number {
  if (attempt <= 1) return 0;

  const exponential = policy.initialDelayMs * 2 ** (attempt - 2);
  const capped = Math.min(exponential, policy.maxDelayMs);
  const jitter = capped * policy.jitterRatio * random();
  return Math.max(0, Math.round(capped - jitter));
}

export interface RetryAttemptLog {
  operation: string;
  attempt: number;
  kind: UpstreamFailureKind;
  delayMs: number;
}

export interface RetryOptions {
  /** Human-readable label used in errors, logs, and the timeout wrapper. */
  operation: string;
  /** Per-attempt deadline. Each attempt gets the full budget. */
  timeoutMs: number;
  /** Defaults to `defaultReadPolicy()`. */
  policy?: RetryPolicy;
  /**
   * Errors the caller handles itself rather than retrying — a 404 that means
   * "not funded yet" or "not visible yet" is a legitimate answer, not a
   * failure. Returning true short-circuits both retry and error mapping.
   *
   * Receives the unwrapped error, so a predicate can match on the upstream's
   * own shape (`response.status`, `name`) without knowing that `withTimeout`
   * may have wrapped it.
   */
  isExpected?: (error: unknown) => boolean;
  /** Structured per-attempt logging. Called once per failed attempt. */
  onAttemptFailed?: (entry: RetryAttemptLog) => void;
  /** Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for deterministic tests. */
  random?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run a **safe, repeatable** upstream read with a per-attempt timeout and
 * bounded retries.
 *
 * Never use this for a call that changes upstream state unless that call's own
 * contract makes repeating it harmless — see the module comment.
 *
 * @param options - `{ operation, timeoutMs, policy?, isExpected?,
 *   onAttemptFailed?, sleep?, random? }`. `operation` labels the call in errors
 *   and logs; `timeoutMs` is the budget for *each* attempt (worst case is
 *   `maxAttempts × timeoutMs` plus backoff); `isExpected` receives the
 *   unwrapped upstream error and, when it returns `true`, short-circuits both
 *   retry and error mapping so the caller gets the upstream's own answer.
 * @param fn - The read to perform, given an `AbortSignal` and the 1-based
 *   attempt number. Invoked up to `policy.maxAttempts` times.
 * @returns The first successful value from `fn`.
 * @throws {AppError} `upstream` once the retries are exhausted or the failure
 *   is not retryable — the upstream's own body never escapes, but the original
 *   error is preserved on the non-enumerable `upstreamCause` for logs.
 * @throws The original upstream error when `options.isExpected` matches it
 *   (e.g. a 404 meaning "not funded yet"), unwrapped from any transport
 *   wrapper so `response.status` and `name` still read as the SDK wrote them.
 */
export async function withRetry<T>(
  options: RetryOptions,
  fn: (signal: AbortSignal, attempt: number) => Promise<T>
): Promise<T> {
  const {
    operation,
    timeoutMs,
    policy = defaultReadPolicy(),
    isExpected,
    onAttemptFailed,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      // Each attempt gets its own full timeout budget, so the worst case is
      // bounded and predictable: maxAttempts × timeoutMs plus backoff.
      return await withTimeout(operation, timeoutMs, (signal) =>
        fn(signal, attempt)
      );
    } catch (error) {
      // An expected error is the caller's answer, not a failure to retry. It is
      // unwrapped first and rethrown in its original form, so a caller matching
      // on `response.status === 404` sees the SDK's error rather than the
      // transport wrapper withTimeout put around it.
      const unwrapped = unwrapUpstreamError(error);
      if (isExpected?.(unwrapped)) throw unwrapped;

      lastError = error;
      const kind = classifyUpstreamFailure(error);
      const { retry, delayMs } = decideRetry(error, attempt, policy, random);

      onAttemptFailed?.({ operation, attempt, kind, delayMs });

      if (!retry) break;
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  throw toUpstreamError(lastError, operation, policy.maxAttempts);
}

/**
 * Map an exhausted or non-retryable failure onto a stable application error.
 *
 * The upstream's own response never reaches the client: Horizon error bodies
 * carry result codes and account identifiers, and an anchor's carry whatever
 * the anchor chose to say. Both are useful in logs and neither belongs in an
 * API response. Callers see one stable shape naming the operation.
 */
export function toUpstreamError(
  error: unknown,
  operation: string,
  attempts: number
): ReturnType<typeof Errors.upstream> {
  const kind = classifyUpstreamFailure(error);

  const mapped =
    kind === "rate_limited"
      ? Errors.upstream(`${operation} is rate limited upstream. Retry shortly.`)
      : kind === "timeout"
        ? Errors.upstream(
            `${operation} did not respond within its deadline after ${attempts} attempt(s)`
          )
        : Errors.upstream(`${operation} is unavailable after ${attempts} attempt(s)`);

  // Keep the originating error reachable for callers that degrade rather than
  // propagate — the SEP-24 poller reports the anchor's HTTP status in its
  // result. Non-enumerable so it cannot leak into a serialized API response.
  Object.defineProperty(mapped, "upstreamCause", {
    value: error,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return mapped;
}

/** The originating failure behind an error produced by `toUpstreamError`. */
export function upstreamCauseOf(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as { upstreamCause?: unknown }).upstreamCause;
}

/** Raised for a retryable HTTP status so the retry loop can classify it. */
export class UpstreamResponseError extends Error {
  readonly status: number;
  readonly operation: string;

  constructor(operation: string, status: number) {
    super(`${operation} returned HTTP ${status}`);
    this.name = "UpstreamResponseError";
    this.status = status;
    this.operation = operation;
  }
}

/**
 * `fetch` for a safe upstream read, with a per-attempt timeout and bounded
 * retries.
 *
 * A non-OK response is only retried when its status says the *upstream*
 * failed. A 4xx is returned to the caller untouched, so the existing per-call
 * handling of "not found", "bad request", and anchor-specific bodies keeps
 * working unchanged — this wrapper decides whether to try again, not what a
 * response means.
 */
export async function fetchWithRetry(
  url: string,
  options: RetryOptions,
  init?: RequestInit
): Promise<Response> {
  return withRetry(options, async (signal) => {
    const response = await fetch(url, { ...init, signal });

    // 429 is surfaced immediately rather than retried: the upstream is asking
    // for less traffic, and retrying into a rate limit is what turns a
    // throttle into an outage.
    if (response.status >= 500) {
      throw new UpstreamResponseError(options.operation, response.status);
    }

    return response;
  });
}

/**
 * Structured logger for a failed attempt. Kept here so every integration logs
 * the same fields — an operator correlating a spike across Horizon and anchor
 * calls should not have to learn two shapes.
 */
export function logRetryAttempt(
  log: { warn: (obj: object, msg: string) => void },
  entry: RetryAttemptLog
): void {
  log.warn(
    {
      operation: entry.operation,
      attempt: entry.attempt,
      failureKind: entry.kind,
      retryInMs: entry.delayMs,
    },
    "upstream call failed"
  );
}
