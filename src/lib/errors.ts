/**
 * Standardized application error handling.
 *
 * Every intentional error thrown by a route handler or service should be an
 * instance of `AppError`. The central error handler in `app.ts` reads these
 * fields to build the standard JSON response:
 *
 *   {
 *     code: string,           // machine-readable code (e.g. "NOT_FOUND")
 *     message: string,        // human-readable description
 *     requestId: string,      // Fastify request.id for correlation / tracing
 *     details?: unknown[],    // optional structured detail (e.g. Zod issues)
 *   }
 *
 * The HTTP status code is conveyed via the response status — it is not
 * duplicated in the body. Stack traces, SQL, credentials, signed XDRs, and
 * upstream response bodies are never included in the response.
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
  INVALID_IDEMPOTENCY_KEY: "INVALID_IDEMPOTENCY_KEY",
  /** A route that requires `Idempotency-Key` was called without one. */
  MISSING_IDEMPOTENCY_KEY: "MISSING_IDEMPOTENCY_KEY",
  NO_SHARE: "NO_SHARE",
  PAYER_SHARE: "PAYER_SHARE",
  SELF_SETTLE: "SELF_SETTLE",
  ACCOUNT_UNFUNDED: "ACCOUNT_UNFUNDED",
  /**
   * Settlement preflight outcomes (see src/services/settlement-preflight.ts).
   * Kept distinct because the remedies differ: establish a trustline, acquire
   * more of the asset, or top up XLM for the fee and account reserve.
   */
  MISSING_TRUSTLINE: "MISSING_TRUSTLINE",
  INSUFFICIENT_BALANCE: "INSUFFICIENT_BALANCE",
  INSUFFICIENT_FEE_BALANCE: "INSUFFICIENT_FEE_BALANCE",
  TREASURY_DISABLED: "TREASURY_DISABLED",
  TREASURY_UNFUNDED: "TREASURY_UNFUNDED",
  INVITE_EXPIRED: "INVITE_EXPIRED",
  INVITE_USED_UP: "INVITE_USED_UP",
  NO_FILE: "NO_FILE",
  BAD_FILE_TYPE: "BAD_FILE_TYPE",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
  /**
   * Request size and shape limits (see src/lib/request-limits.ts). Answered
   * with 413 rather than 400: the request was well-formed, just too large.
   * Distinct codes so a client can tell "shrink the file" from "send fewer
   * files" from "shorten this field".
   */
  REQUEST_TOO_LARGE: "REQUEST_TOO_LARGE",
  TOO_MANY_FILES: "TOO_MANY_FILES",
  FIELD_TOO_LARGE: "FIELD_TOO_LARGE",
  TOO_MANY_PARTS: "TOO_MANY_PARTS",
  XDR_MISMATCH: "XDR_MISMATCH",
  /** The envelope could not be parsed at all — not that it failed to match. */
  XDR_MALFORMED: "XDR_MALFORMED",
  /** An envelope arrived with no usable signature for the configured network. */
  XDR_UNSIGNED: "XDR_UNSIGNED",
  /**
   * An unsigned transaction intent was signed or submitted after its
   * server-controlled validity window. Distinct from XDR_MISMATCH (the
   * envelope is wrong) and from UNAUTHORIZED/FORBIDDEN (the caller is wrong):
   * the correct client response is to request a fresh transaction and sign it
   * promptly. See src/lib/time-bounds.ts.
   */
  INTENT_EXPIRED: "INTENT_EXPIRED",
  /**
   * 401 — the signed SEP-10 challenge arrived after its validity window
   * closed. Deliberately distinct from UNAUTHORIZED (signature or domain
   * failure — the envelope itself is wrong) and TOKEN_EXPIRED (a session
   * credential, not a challenge): the remedy is to request a fresh challenge
   * and sign it promptly. See src/services/sep10.ts.
   */
  CHALLENGE_EXPIRED: "CHALLENGE_EXPIRED",
  INVALID_CURSOR: "INVALID_CURSOR",
  // 401
  UNAUTHORIZED: "UNAUTHORIZED",
  /**
   * 401 — a structurally valid session token whose `exp` has passed (or that
   * sits inside the expiry margin). Deliberately distinct from UNAUTHORIZED
   * and INVALID_TOKEN so a client knows the credential was once good and the
   * remedy is to re-authenticate (SEP-10) or exchange a refresh token.
   */
  TOKEN_EXPIRED: "TOKEN_EXPIRED",
  /**
   * 401 — the presented token could not be verified at all: malformed JWT,
   * bad signature, wrong issuer/audience/algorithm, or missing required
   * claims. Distinct from TOKEN_EXPIRED so a client does not mistake an
   * unusable credential for a merely old one.
   */
  INVALID_TOKEN: "INVALID_TOKEN",
  // 403
  FORBIDDEN: "FORBIDDEN",
  // 404
  NOT_FOUND: "NOT_FOUND",
  // 409
  CONFLICT: "CONFLICT",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  /** The same key is still executing its first request; retry shortly. */
  IDEMPOTENCY_IN_PROGRESS: "IDEMPOTENCY_IN_PROGRESS",
  ALREADY_SETTLED: "ALREADY_SETTLED",
  EXPENSE_SETTLED: "EXPENSE_SETTLED",
  LAST_ADMIN: "LAST_ADMIN",
  /**
   * 409 — a unique constraint rejected the write, so a record with these values
   * already exists. Distinct from the state codes above, which name a workflow
   * the caller can inspect, and from a bare CONFLICT: here the request is
   * well-formed and the remedy is a different value, not a different action.
   * See src/lib/prisma-error.ts.
   */
  DUPLICATE_RECORD: "DUPLICATE_RECORD",
  // 429
  RATE_LIMITED: "RATE_LIMITED",
  // 500
  INTERNAL_ERROR: "INTERNAL_ERROR",
  // 502 — an upstream dependency (Horizon, anchor) was unreachable or unusable.
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
  /**
   * 502 — the provider processed the request and rejected it (e.g. Horizon
   * result codes such as `tx_bad_seq`, or an anchor 4xx). Distinct from
   * UPSTREAM_ERROR so callers and workers can tell a permanent rejection from
   * a transient dependency failure. See src/lib/provider-error.ts.
   */
  PROVIDER_REJECTED: "PROVIDER_REJECTED",
  // 503 — a dependency this process needs is unavailable, so the request could
  // not be attempted at all. Used for the database being unreachable, refused,
  // or timed out — the same condition /health already reports as not-ready, and
  // distinct from UPSTREAM_ERROR, which is a third-party HTTP dependency. See
  // src/lib/prisma-error.ts.
  SERVICE_UNAVAILABLE: "SERVICE_UNAVAILABLE",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export {
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
  InternalServerError,
} from "../errors/app-error";

import { AppError } from "../errors/app-error";


/** Factory helpers — mirrors the original `Errors` object in src/errors.ts. */
export const Errors = {
  unauthorized: (msg = "Authentication required") =>
    new AppError(401, ErrorCode.UNAUTHORIZED, msg),

  /**
   * The session token's expiry has passed. Carries a `details.hint` naming
   * the re-authentication path — SEP-10 challenge/verify, or the refresh
   * endpoint for clients holding a refresh token — so a wallet integration
   * can react to the code without hard-coding the API's auth flow.
   */
  tokenExpired: (msg = "Token expired") =>
    new AppError(401, ErrorCode.TOKEN_EXPIRED, msg, {
      hint: "Re-authenticate via SEP-10 (POST /auth/challenge, then POST /auth/verify), or exchange a refresh token via POST /auth/refresh.",
    }),

  /** The bearer token failed verification — malformed, wrong signature, or
   * missing claims. There is nothing to refresh; the caller must present a
   * token this API actually minted. */
  invalidToken: (msg = "Invalid token") =>
    new AppError(401, ErrorCode.INVALID_TOKEN, msg),

  /**
   * The SEP-10 challenge the wallet signed has passed its validity window.
   * Deliberately distinct from the generic UNAUTHORIZED rejection of
   * signature and domain failures (see src/services/sep10.ts): the envelope
   * was otherwise well-formed and correctly signed, so the only remedy is to
   * request a fresh challenge and sign it promptly. Carries
   * `details.challengeValiditySeconds` so clients can size their own
   * sign-prompt timeout without hard-coding one.
   */
  challengeExpired: (msg: string, details?: unknown) =>
    new AppError(401, ErrorCode.CHALLENGE_EXPIRED, msg, details),

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
