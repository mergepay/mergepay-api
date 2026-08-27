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
 *   - HTTP 5xx — the upstream failed, not the request.
 *
 * Never retried:
 *
 *   - 4xx other than 429 — a validation or authentication failure repeats
 *     identically, so retrying only multiplies load and delays the error the
 *     caller needs to see.
 *   - 429 — the upstream is explicitly asking for less traffic. Retrying into
 *     a rate limit is what turns a throttle into an outage, so a 429 is
 *     surfaced immediately with its `Retry-After` preserved for the caller.
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
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "unknown";
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
      const isLastAttempt = attempt >= policy.maxAttempts;
      const retryable = isRetryableFailure(kind) && !isLastAttempt;
      const delayMs = retryable ? backoffDelayMs(attempt + 1, policy, random) : 0;

      onAttemptFailed?.({ operation, attempt, kind, delayMs });

      if (!retryable) break;
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
