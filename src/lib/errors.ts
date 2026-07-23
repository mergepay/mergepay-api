/**
 * Standardized application error handling.
 *
 * Every intentional error thrown by a route handler or service should be an
 * instance of `AppError`. The central error handler in `app.ts` reads these
 * fields to build the standard JSON response:
 *
 *   {
 *     error: string,          // machine-readable code (e.g. "NOT_FOUND")
 *     message: string,        // human-readable description
 *     statusCode: number,     // mirrors the HTTP status (e.g. 404)
 *     details?: unknown,      // optional structured detail (e.g. Zod issues)
 *     requestId?: string      // Fastify request.id for correlation / tracing
 *   }
 */

/** All first-class error codes used across the API. */
export const ErrorCode = {
  // 400
  VALIDATION_ERROR: "VALIDATION_ERROR",
  BAD_REQUEST: "BAD_REQUEST",
  INVALID_ACCOUNT: "INVALID_ACCOUNT",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_PAYER: "INVALID_PAYER",
  INVALID_PARTICIPANT: "INVALID_PARTICIPANT",
  INVALID_SPLIT: "INVALID_SPLIT",
  INVALID_PUBLIC_KEY: "INVALID_PUBLIC_KEY",
  INVALID_RECIPIENT: "INVALID_RECIPIENT",
  INVALID_DESTINATION: "INVALID_DESTINATION",
  NO_SHARE: "NO_SHARE",
  PAYER_SHARE: "PAYER_SHARE",
  SELF_SETTLE: "SELF_SETTLE",
  ACCOUNT_UNFUNDED: "ACCOUNT_UNFUNDED",
  TREASURY_DISABLED: "TREASURY_DISABLED",
  TREASURY_UNFUNDED: "TREASURY_UNFUNDED",
  INVITE_EXPIRED: "INVITE_EXPIRED",
  INVITE_USED_UP: "INVITE_USED_UP",
  NO_FILE: "NO_FILE",
  BAD_FILE_TYPE: "BAD_FILE_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  XDR_MISMATCH: "XDR_MISMATCH",
  // 401
  UNAUTHORIZED: "UNAUTHORIZED",
  // 403
  FORBIDDEN: "FORBIDDEN",
  // 404
  NOT_FOUND: "NOT_FOUND",
  // 409
  CONFLICT: "CONFLICT",
  ALREADY_SETTLED: "ALREADY_SETTLED",
  EXPENSE_SETTLED: "EXPENSE_SETTLED",
  LAST_ADMIN: "LAST_ADMIN",
  // 429
  RATE_LIMITED: "RATE_LIMITED",
  // 500
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // 502
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

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
  /** Correlation ID injected by the error handler, not set by callers. */
  requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
  }
}

/** Factory helpers — mirrors the original `Errors` object in src/errors.ts. */
export const Errors = {
  unauthorized: (msg = "Authentication required") =>
    new AppError(401, ErrorCode.UNAUTHORIZED, msg),

  forbidden: (msg = "You do not have access to this resource") =>
    new AppError(403, ErrorCode.FORBIDDEN, msg),

  notFound: (msg = "Not found") =>
    new AppError(404, ErrorCode.NOT_FOUND, msg),

  badRequest: (code: string, msg: string, details?: unknown) =>
    new AppError(400, code.toUpperCase(), msg, details),

  conflict: (code: string, msg: string, details?: unknown) =>
    new AppError(409, code.toUpperCase(), msg, details),

  upstream: (msg: string) =>
    new AppError(502, ErrorCode.UPSTREAM_ERROR, msg),

  validation: (msg: string, details?: unknown) =>
    new AppError(400, ErrorCode.VALIDATION_ERROR, msg, details),

  internal: (msg = "Something went wrong.") =>
    new AppError(500, ErrorCode.INTERNAL_ERROR, msg),
};
