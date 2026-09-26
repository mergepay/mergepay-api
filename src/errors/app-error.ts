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
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.statusCode = status;
    this.code = code;
    this.details = details;
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
