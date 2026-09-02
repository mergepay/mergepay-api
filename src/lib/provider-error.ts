/**
 * Structured failures for external providers (Stellar Horizon, SEP-24 anchor).
 *
 * Services under src/services/* are the only place that touch provider I/O;
 * they convert whatever the SDK/fetch threw into a `ProviderError` (or another
 * intentional `AppError`) before it escapes. Callers — Fastify handlers and
 * workers — then see a normalized category instead of provider-specific
 * exceptions:
 *
 *   timeout        the provider did not answer inside its deadline. The call
 *                  MAY have taken effect; treat as indeterminate for retries.
 *   transport      connection-level failure (DNS, refused, reset). The call
 *                  almost certainly did not take effect; safe to retry.
 *   rate_limited   the provider throttled us. Retry later with backoff.
 *   unavailable    the provider answered with 5xx or an unusable payload.
 *                  Safe to retry.
 *   malformed      the provider responded but the body could not be parsed or
 *                  did not match the expected schema.
 *   rejected       the provider processed and rejected the request (Horizon
 *                  result codes such as `tx_bad_seq`, or an anchor 4xx).
 *                  Permanent — retrying cannot help.
 *
 * Client-visible messages stay generic; only safe provider identifiers (a
 * validated result-code token list) may be appended for debugging. Tokens,
 * authorization headers, signed XDRs, and raw upstream payloads never reach
 * the message, the details, or ordinary logs.
 */

import { AppError, ErrorCode } from "./errors";

export type ProviderFailureCategory =
  | "timeout"
  | "transport"
  | "rate_limited"
  | "unavailable"
  | "malformed"
  | "rejected";

/** HTTP status for every provider failure — dependencies fail as 502. */
const PROVIDER_STATUS = 502;

export interface ProviderErrorParams {
  category: ProviderFailureCategory;
  /** Stable provider identifier, e.g. "horizon" or "anchor". */
  provider: string;
  /** Operation label, e.g. "Anchor.getChallenge" (also used in logs). */
  operation: string;
  /** Generic client-safe message, e.g. "Anchor SEP-10 challenge request failed". */
  message: string;
  /**
   * Optional safe identifier(s) for debugging (e.g. Horizon result codes).
   * Anything that is not a plain opaque token is dropped.
   */
  detail?: unknown;
}

/**
 * Only opaque identifier tokens survive into messages/details: result codes,
 * status words, domains. Sentences from provider errors could carry upstream
 * payloads, URLs with query strings, or worse — so anything else is dropped.
 */
function safeIdentifier(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  const trimmed = detail.trim();
  return /^[A-Za-z0-9_:.-]{1,120}$/.test(trimmed) ? trimmed : null;
}

function safeDetailList(detail: unknown): string | null {
  if (Array.isArray(detail)) {
    const parts = detail
      .map(safeIdentifier)
      .filter((part): part is string => part !== null);
    return parts.length > 0 ? parts.join(",") : null;
  }
  return safeIdentifier(detail);
}

/**
 * A categorized provider failure. Extends AppError so it flows through the
 * existing central error handler unchanged and produces the repository's
 * standard `{ code, message, requestId }` envelope.
 */
export class ProviderError extends AppError {
  readonly category: ProviderFailureCategory;
  readonly provider: string;
  readonly operation: string;
  /**
   * True when retrying the same request can plausibly succeed (dependency
   * categories). False for permanent rejections. A timeout is marked
   * non-retryable here because its outcome is indeterminate — workers must
   * verify against the ledger rather than blindly resubmit; see
   * classifyJobFailure in src/services/job-retry.ts.
   */
  readonly retryable: boolean;
  /** Sanitized safe identifiers (e.g. Horizon result codes), if any. */
  readonly detail: string[] | null;

  constructor(params: ProviderErrorParams) {
    const detail = safeDetailList(params.detail);
    super(
      PROVIDER_STATUS,
      params.category === "rejected"
        ? ErrorCode.PROVIDER_REJECTED
        : ErrorCode.UPSTREAM_ERROR,
      detail ? `${params.message}: ${detail}` : params.message,
    );
    this.name = "ProviderError";
    this.category = params.category;
    this.provider = params.provider;
    this.operation = params.operation;
    this.retryable =
      params.category !== "rejected" && params.category !== "timeout";
    this.detail = detail ? detail.split(",") : null;
  }
}
