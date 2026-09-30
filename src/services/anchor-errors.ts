/**
 * Typed failures for SEP-24 anchor reads.
 *
 * Each class is a `ProviderError`, so it flows through the central error
 * handler unchanged: every anchor failure answers 502 with the repository's
 * standard `{ code, message, requestId }` envelope, `PROVIDER_REJECTED` for a
 * permanent anchor rejection and `UPSTREAM_ERROR` for everything else (see
 * src/lib/provider-error.ts). The subclass tells in-process callers — the
 * worker in particular — *why* the anchor failed without parsing messages.
 *
 * Messages are generic. The anchor's response body, the request URL, and the
 * SEP-10 token never reach them; only the HTTP status and the names of
 * invalid fields (safe identifiers) do.
 */
import { ProviderError, type ProviderFailureCategory } from "../lib/provider-error";

const PROVIDER = "anchor";

export type AnchorErrorKind =
  | "timeout"
  | "network"
  | "unavailable"
  | "upstream"
  | "auth"
  | "not_found"
  | "validation";

export abstract class AnchorError extends ProviderError {
  abstract readonly kind: AnchorErrorKind;
  /** The anchor's HTTP status, when the failure is an HTTP response. */
  readonly httpStatus: number | null;

  protected constructor(params: {
    category: ProviderFailureCategory;
    operation: string;
    message: string;
    httpStatus?: number | null;
    detail?: unknown;
  }) {
    super({
      category: params.category,
      provider: PROVIDER,
      operation: params.operation,
      message: params.message,
      detail: params.detail,
    });
    this.httpStatus = params.httpStatus ?? null;
  }
}

/** No response inside the deadline (ours, or the anchor's own HTTP 408). */
export class AnchorTimeoutError extends AnchorError {
  readonly kind = "timeout" as const;

  constructor(operation: string, opts: { httpStatus?: number } = {}) {
    super({
      category: "timeout",
      operation,
      message: "Anchor did not respond in time",
      httpStatus: opts.httpStatus,
    });
    this.name = "AnchorTimeoutError";
  }
}

/** Connection-level failure: DNS, refused, reset. */
export class AnchorNetworkError extends AnchorError {
  readonly kind = "network" as const;

  constructor(operation: string) {
    super({ category: "transport", operation, message: "Anchor could not be reached" });
    this.name = "AnchorNetworkError";
  }
}

/** The circuit breaker is open, so the anchor was not called at all. */
export class AnchorUnavailableError extends AnchorError {
  readonly kind = "unavailable" as const;

  constructor(operation: string) {
    super({
      category: "unavailable",
      operation,
      message: "Anchor is temporarily unavailable",
    });
    this.name = "AnchorUnavailableError";
  }
}

function httpCategory(status: number | null): ProviderFailureCategory {
  if (status === null) return "unavailable";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "unavailable";
  return "rejected";
}

/**
 * Any other non-OK anchor response: 5xx, 429, or a 4xx with no dedicated
 * class. `httpStatus` is null only for a failure that could not be
 * classified at all.
 */
export class AnchorUpstreamError extends AnchorError {
  readonly kind = "upstream" as const;

  constructor(operation: string, httpStatus: number | null) {
    super({
      category: httpCategory(httpStatus),
      operation,
      message:
        httpStatus === null
          ? "Anchor request failed"
          : `Anchor responded with HTTP ${httpStatus}`,
      httpStatus,
    });
    this.name = "AnchorUpstreamError";
  }
}

/** 401/403: the anchor rejected the SEP-10 token, typically because it expired. */
export class AnchorAuthError extends AnchorError {
  readonly kind = "auth" as const;

  constructor(operation: string, httpStatus: 401 | 403) {
    super({
      category: "rejected",
      operation,
      message: `Anchor rejected the SEP-10 token (HTTP ${httpStatus})`,
      httpStatus,
    });
    this.name = "AnchorAuthError";
  }
}

/** 404: the anchor has no record of the requested transaction. */
export class AnchorNotFoundError extends AnchorError {
  readonly kind = "not_found" as const;

  constructor(operation: string) {
    super({
      category: "rejected",
      operation,
      message: "Anchor has no record of the transaction",
      httpStatus: 404,
    });
    this.name = "AnchorNotFoundError";
  }
}

export type AnchorValidationReason = "invalid_json" | "schema" | "id_mismatch";

/** The anchor answered 2xx, but not with a usable SEP-24 transaction. */
export class AnchorValidationError extends AnchorError {
  readonly kind = "validation" as const;
  readonly reason: AnchorValidationReason;
  /** Dotted paths of the invalid fields (e.g. `transaction.kind`). */
  readonly fields: string[];

  constructor(operation: string, reason: AnchorValidationReason, fields: string[] = []) {
    super({
      category: "malformed",
      operation,
      message:
        reason === "invalid_json"
          ? "Anchor returned a malformed (non-JSON) response"
          : reason === "id_mismatch"
            ? "Anchor returned a different transaction than requested"
            : "Anchor returned an invalid SEP-24 transaction",
      detail: fields,
    });
    this.name = "AnchorValidationError";
    this.reason = reason;
    this.fields = fields;
  }
}

/** Map a non-OK anchor HTTP status onto its typed error. */
export function anchorErrorForStatus(operation: string, status: number): AnchorError {
  if (status === 401 || status === 403) return new AnchorAuthError(operation, status);
  if (status === 404) return new AnchorNotFoundError(operation);
  if (status === 408) return new AnchorTimeoutError(operation, { httpStatus: status });
  return new AnchorUpstreamError(operation, status);
}
