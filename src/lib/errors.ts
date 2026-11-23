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
  /**
   * 401 — the signed SEP-10 challenge declares a window that has not opened
   * yet (its `minTime` is beyond the clock-skew tolerance). Distinct from
   * CHALLENGE_EXPIRED (window closed) and UNAUTHORIZED (structural or
   * signature failure): the envelope's bounds are present and usable but do
   * not describe a presently redeemable challenge. See src/services/sep10.ts.
   */
  CHALLENGE_NOT_YET_VALID: "CHALLENGE_NOT_YET_VALID",
  /**
   * 401 — the signed SEP-10 challenge declares a window longer than the
   * validity this server grants, so it is not an envelope this server issued
   * however well it otherwise verifies. Distinct from CHALLENGE_EXPIRED and
   * UNAUTHORIZED for the same reason. See src/services/sep10.ts.
   */
  CHALLENGE_WINDOW_TOO_LONG: "CHALLENGE_WINDOW_TOO_LONG",
  INVALID_CURSOR: "INVALID_CURSOR",
  // 401
  UNAUTHORIZED: "UNAUTHORIZED",
  /**
   * 401 — the SEP-10 challenge is not one this server will redeem: it does not
   * decode, does not carry this server's signature, is structurally unlike what
   * this server issues, or has already been redeemed. The catch-all for
   * challenge failures; the codes below are only ever earned by an envelope
   * this server demonstrably signed. See src/services/sep10.ts.
   */
  INVALID_CHALLENGE: "INVALID_CHALLENGE",
  /**
   * 401 — the challenge carries this server's signature, but over another
   * Stellar network's passphrase. The client requested its challenge from a
   * deployment on a different network (or mixed up passphrases while signing).
   */
  NETWORK_MISMATCH: "NETWORK_MISMATCH",
  /**
   * 400 on the request (`home_domain` names another domain) or 401 on a
   * server-signed challenge whose `<home domain> auth` operation names a domain
   * this server no longer authenticates for. The remedy is the same: request a
   * fresh challenge for this server's home domain.
   */
  HOME_DOMAIN_MISMATCH: "HOME_DOMAIN_MISMATCH",
  /**
   * 401 on a SEP-10 challenge whose client signatures do not verify (missing,
   * invalid, unrecognized, or below the account's medium threshold); 400 on a
   * treasury envelope whose signature does not verify. The envelope itself is
   * fine — the remedy is re-signing it with the right key(s).
   */
  INVALID_SIGNATURE: "INVALID_SIGNATURE",
  /**
   * 401 — a protected route was called with no `Authorization` header at all.
   * Answered with `WWW-Authenticate: Bearer realm=...` and no error code, per
   * RFC 6750 §3.1.
   */
  MISSING_TOKEN: "MISSING_TOKEN",
  /**
   * 401 — an `Authorization` header is present but is not `Bearer <token>`, or
   * the token is not shaped like a JWT at all (not three base64url segments,
   * or a header/payload that does not decode). Answered with
   * `error="invalid_request"`. Distinct from INVALID_TOKEN: the client sent
   * something other than a credential, rather than a credential that failed.
   */
  MALFORMED_TOKEN: "MALFORMED_TOKEN",
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
  BearerAuthError,
} from "../errors/app-error";

import { AppError, BearerAuthError } from "../errors/app-error";


/** Factory helpers — mirrors the original `Errors` object in src/errors.ts. */
export const Errors = {
  unauthorized: (msg = "Authentication required") =>
    new AppError(401, ErrorCode.UNAUTHORIZED, msg),

  /** No `Authorization` header on a protected route. See MISSING_TOKEN. */
  missingToken: (
    msg = "Authentication required. Send a bearer token in the Authorization header."
  ) => new BearerAuthError(ErrorCode.MISSING_TOKEN, msg, null),

  /** Not `Bearer <token>`, or a token not shaped like a JWT. See MALFORMED_TOKEN. */
  malformedToken: (msg = "Authentication token is malformed") =>
    new BearerAuthError(ErrorCode.MALFORMED_TOKEN, msg, "invalid_request"),

  /**
   * The session token's expiry has passed. Carries a `details.hint` naming
   * the re-authentication path — SEP-10 challenge/verify, or the refresh
   * endpoint for clients holding a refresh token — so a wallet integration
   * can react to the code without hard-coding the API's auth flow.
   */
  tokenExpired: (msg = "Authentication token has expired", details?: unknown) =>
    new BearerAuthError(ErrorCode.TOKEN_EXPIRED, msg, "invalid_token", details),

  /**
   * The bearer token failed verification — wrong signature, disallowed
   * algorithm, wrong issuer/audience, not yet valid, or a claims shape that
   * does not identify an account. A refresh token cannot rescue a token like
   * this; the client must re-authenticate via SEP-10.
   */
  invalidToken: (msg = "Authentication token is invalid", details?: unknown) =>
    new BearerAuthError(ErrorCode.INVALID_TOKEN, msg, "invalid_token", details),

  /** See INVALID_CHALLENGE. */
  invalidChallenge: (
    msg = "Authentication challenge is invalid. Request a new challenge and sign it without modification."
  ) => new AppError(401, ErrorCode.INVALID_CHALLENGE, msg),

  /** See NETWORK_MISMATCH. */
  challengeNetworkMismatch: (msg: string, details?: unknown) =>
    new AppError(401, ErrorCode.NETWORK_MISMATCH, msg, details),

  /** See HOME_DOMAIN_MISMATCH. */
  challengeHomeDomainMismatch: (msg: string, details?: unknown) =>
    new AppError(401, ErrorCode.HOME_DOMAIN_MISMATCH, msg, details),

  /** See INVALID_SIGNATURE. */
  challengeSignatureInvalid: (msg: string) =>
    new AppError(401, ErrorCode.INVALID_SIGNATURE, msg),

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

  /** The challenge's `minTime` has not been reached — bounds are usable but
   * the window has not opened. See CHALLENGE_NOT_YET_VALID. */
  challengeNotYetValid: (msg: string, details?: unknown) =>
    new AppError(401, ErrorCode.CHALLENGE_NOT_YET_VALID, msg, details),

  /** The challenge's window outlives the validity this server issues. See
   * CHALLENGE_WINDOW_TOO_LONG. */
  challengeWindowTooLong: (msg: string, details?: unknown) =>
    new AppError(401, ErrorCode.CHALLENGE_WINDOW_TOO_LONG, msg, details),

  forbidden: (msg = "You do not have access to this resource") =>
    new AppError(403, ErrorCode.FORBIDDEN, msg),

  notFound: (msg = "Not found") =>
    new AppError(404, ErrorCode.NOT_FOUND, msg),

  badRequest: (code: string, msg: string, details?: unknown) =>
    new AppError(400, code.toUpperCase(), msg, details),

  unprocessable: (code: string, msg: string, details?: unknown) =>
    new AppError(422, code.toUpperCase(), msg, details),

  conflict: (code: string, msg: string, details?: unknown) =>
    new AppError(409, code.toUpperCase(), msg, details),

  upstream: (msg: string) =>
    new AppError(502, ErrorCode.UPSTREAM_ERROR, msg),

  validation: (msg: string, details?: unknown) =>
    new AppError(400, ErrorCode.VALIDATION_ERROR, msg, details),

  internal: (msg = "Something went wrong.") =>
    new AppError(500, ErrorCode.INTERNAL_ERROR, msg),
};
