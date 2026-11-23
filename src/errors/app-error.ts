/**
 * Application error with a stable machine-readable code, HTTP status,
 * optional structured details, and an optional correlation request ID.
 *
 * The `requestId` is injected by the central error handler — callers do not
 * need to set it.
 */
export class AppError extends Error {
  /** HTTP status code (e.g. 404). */
  readonly status: number;
  /** Mirror of `status` — Fastify reads `statusCode` on error objects. */
  readonly statusCode: number;
  /** Machine-readable error code string (e.g. "NOT_FOUND"). */
  readonly code: string;
  /** Structured detail payload (e.g. Zod validation issues). */
  readonly details?: unknown;
  /** Optional retry hint for 429 responses. */
  readonly retryAfterSeconds?: number;
  /** Correlation ID injected by the error handler, not set by callers. */
  requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
    this.retryAfterSeconds = retryAfterSeconds;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * 404 Not Found error.
 */
export class NotFoundError extends AppError {
  constructor(message: string = "Not found", details?: unknown) {
    super(404, "NOT_FOUND", message, details);
    this.name = "NotFoundError";
  }
}

/**
 * 400 Validation Error.
 */
export class ValidationError extends AppError {
  constructor(message: string = "Validation failed", details?: unknown) {
    super(400, "VALIDATION_ERROR", message, details);
    this.name = "ValidationError";
  }
}

/**
 * 401 Unauthorized error.
 */
export class UnauthorizedError extends AppError {
  constructor(message: string = "Unauthorized", details?: unknown) {
    super(401, "UNAUTHORIZED", message, details);
    this.name = "UnauthorizedError";
  }
}

/** Realm named in every bearer challenge this API issues. */
export const BEARER_REALM = "mergepay-api";

/** RFC 6750 §3.1 error codes this API reports in a bearer challenge. */
export type BearerErrorCode = "invalid_request" | "invalid_token";

/**
 * 401 for a protected route's bearer credential — missing, malformed, invalid,
 * or expired.
 *
 * Carries the `WWW-Authenticate` challenge RFC 6750 §3 requires on such a 401;
 * the central error handler sends it. `bearerError` is `null` when the request
 * carried no credential at all, because RFC 6750 §3.1 says the challenge then
 * SHOULD NOT include an error code. The `error_description` is the error's own
 * fixed, client-safe message — never library text.
 */
export class BearerAuthError extends AppError {
  readonly bearerError: BearerErrorCode | null;

  constructor(
    code: string,
    message: string,
    bearerError: BearerErrorCode | null,
    details?: unknown
  ) {
    super(401, code, message, details);
    this.name = "BearerAuthError";
    this.bearerError = bearerError;
  }

  /** The `WWW-Authenticate` header value for this rejection. */
  get wwwAuthenticate(): string {
    if (!this.bearerError) return `Bearer realm="${BEARER_REALM}"`;
    // quoted-string per RFC 7235: drop the two characters that would end or
    // escape it, so no message can corrupt the header.
    const description = this.message.replace(/["\\]/g, "");
    return `Bearer realm="${BEARER_REALM}", error="${this.bearerError}", error_description="${description}"`;
  }
}

/**
 * 403 Forbidden error.
 */
export class ForbiddenError extends AppError {
  constructor(message: string = "Forbidden", details?: unknown) {
    super(403, "FORBIDDEN", message, details);
    this.name = "ForbiddenError";
  }
}

/**
 * 409 Conflict error.
 */
export class ConflictError extends AppError {
  constructor(message: string = "Conflict", details?: unknown) {
    super(409, "CONFLICT", message, details);
    this.name = "ConflictError";
  }
}

/**
 * 400 Bad Request error.
 */
export class BadRequestError extends AppError {
  constructor(message: string = "Bad request", details?: unknown, code: string = "BAD_REQUEST") {
    super(400, code, message, details);
    this.name = "BadRequestError";
  }
}

/**
 * 500 Internal Server Error.
 */
export class InternalServerError extends AppError {
  constructor(message: string = "Internal server error", details?: unknown) {
    super(500, "INTERNAL_ERROR", message, details);
    this.name = "InternalServerError";
  }
}
