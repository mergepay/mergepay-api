/**
 * Prisma/PostgreSQL failures translated into API errors.
 *
 * ## Why this exists
 *
 * Every read and write in this API goes through Prisma, and Prisma reports a
 * rejected statement by throwing. Nothing below the query layer caught those,
 * so a duplicate key, a dangling foreign key, or a missing required field
 * reached the central error handler as an unrecognised exception and was
 * answered with the generic `500 INTERNAL_ERROR` — indistinguishable from a bug
 * in this process, and useless to the caller, who can only conclude "retry,
 * probably still broken".
 *
 * Most of these are not outages at all. A `409` for a unique-constraint
 * violation is the correct answer for a submission that raced another
 * submission, and a `404` for a row that vanished mid-request is the correct
 * answer for an update. This module is the single place that says so, so the
 * mapping does not have to be re-derived (or forgotten) per repository.
 *
 * ## The mapping
 *
 * | Prisma code | Status | Client answer |
 * | --- | --- | --- |
 * | `P2002` unique constraint | 409 `DUPLICATE_RECORD` | the value already exists |
 * | `P2000` value too long | 400 `VALIDATION_ERROR` | shorten the value |
 * | `P2003` foreign key | 400 `VALIDATION_ERROR` | the referenced row does not exist |
 * | `P2004` constraint failed | 400 `VALIDATION_ERROR` | the value broke a check constraint |
 * | `P2007` invalid data | 400 `VALIDATION_ERROR` | the value is out of range for the column |
 * | `P2011` null constraint | 400 `VALIDATION_ERROR` | a required field was null |
 * | `P2012` missing value | 400 `VALIDATION_ERROR` | a required field was not sent |
 * | `P2014` missing relation | 400 `VALIDATION_ERROR` | a required relation was not sent |
 * | `P2001`, `P2025` not found | 404 `NOT_FOUND` | the row does not exist |
 * | `P2034` write conflict | 409 `CONFLICT` | retry (deadlock) |
 * | `P1xxx` client lifecycle | 503 `SERVICE_UNAVAILABLE` | the database is unreachable — retry |
 * | `P2008`, `P2010` bad statement | 500 `INTERNAL_ERROR` | our SQL is wrong |
 *
 * `P2001`/`P2025` are only the codes Prisma raises for *required* records;
 * `findUnique` and friends return `null` instead, so this does not change how
 * ordinary "no such row" reads behave.
 *
 * ## Where this sits
 *
 * Three services (idempotency, treasury proposals, treasury signatures) already
 * catch `P2002` themselves, because a unique violation there is a race they
 * have to resolve: the loser of the race reads the winning row rather than
 * failing. That stays as it is — this module is the backstop for the writes
 * nobody special-cased, and it never second-guesses an error a service has
 * already turned into an `AppError` of its own.
 *
 * ## What is never leaked
 *
 * Prisma error messages quote the statement, the column list, the constraint
 * name, and sometimes the arguments — the kind of text that ends up naming
 * tables, or echoing a value back. Every message here is fixed prose written
 * for a client, and the only thing taken from the error is a *name* (a column, a
 * model), filtered to an identifier-shaped token. Values are never read, so
 * nothing from a request body can reach the response or the log through this
 * module. The Postgres constraint name is read too, but kept out of the
 * response — it is database naming a client cannot act on, so it is logged
 * only.
 *
 * Matching is structural (`code` / `errorCode` / `name`) rather than
 * `instanceof`, for the same reason `src/lib/request-limits.ts` matches codes
 * instead of classes: the codes are Prisma's documented public contract, the
 * class identity is not — a client bundled twice, or a driver error crossing a
 * worker boundary, is still a `P2002` and should still be translated.
 */

import { ErrorCode } from "./errors";

/** Schema metadata about the statement that was rejected. */
export interface PrismaErrorDetails {
  /** Columns or index entries involved, e.g. `["groupId", "userId"]`. */
  fields?: string[];
  /** Prisma model the write targeted, e.g. `Settlement`. */
  model?: string;
}

/** A Prisma failure, resolved to what the client should be told. */
export interface PrismaErrorTranslation {
  status: number;
  code: string;
  message: string;
  details?: PrismaErrorDetails;
  /**
   * The database constraint that rejected the write, e.g.
   * `settlement_expense_share_idempotency`. Deliberately kept out of `details`:
   * it is Postgres naming, of no use to a client, so it is logged and not sent.
   */
  constraint?: string;
  /** Prisma's own code, so the log can be correlated with a driver message. */
  prismaCode: string;
  /** The same request could plausibly succeed if the client simply retried. */
  retryable: boolean;
}

/**
 * Only identifier-shaped tokens survive from `meta`: constraint, column, and
 * model names. Anything else (a value, a sentence, a JSON blob) is dropped
 * rather than trimmed, because a single unexpected shape in `meta` must not be
 * able to put arbitrary text into a response body.
 */
function safeIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9_$.:()-]{1,120}$/.test(trimmed) ? trimmed : null;
}

function safeIdentifierList(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of entries) {
    const identifier = safeIdentifier(entry);
    if (identifier && !out.includes(identifier)) out.push(identifier);
    // Bounded: `meta` is attacker-adjacent data, and this ends up in a response.
    if (out.length === 10) break;
  }
  return out;
}

/**
 * Prisma names the offending columns differently per code and per version —
 * `target` for `P2002`, `field_name` for `P2003`, `constraint` for a null or
 * check violation, sometimes a bare string where a later version sends an
 * array. Read all of them and keep whatever is identifier-shaped, so the
 * details survive a client upgrade instead of silently going empty.
 *
 * The constraint name is read separately because it is not client-safe: it is
 * Postgres naming, and the columns already say everything a client can act on.
 */
function readMeta(meta: unknown): { details?: PrismaErrorDetails; constraint?: string } {
  if (!meta || typeof meta !== "object") return {};
  const source = meta as Record<string, unknown>;

  const constraint = safeIdentifier(source.constraint);
  const details: PrismaErrorDetails = {};

  const fields = safeIdentifierList(
    source.target ?? source.fields ?? source.field_name ?? source.field
  );
  if (fields.length > 0) details.fields = fields;

  const model = safeIdentifier(source.modelName ?? source.model);
  if (model) details.model = model;

  return {
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(constraint ? { constraint } : {}),
  };
}

function build(
  status: number,
  code: string,
  message: string,
  prismaCode: string,
  meta: unknown,
  retryable = false
): PrismaErrorTranslation {
  return { status, code, message, prismaCode, retryable, ...readMeta(meta) };
}

/**
 * `PrismaClientKnownRequestError` codes: a statement the database understood
 * and rejected. The key is the stable, documented code, never the message.
 */
const KNOWN_REQUEST_ERRORS: Record<string, (meta: unknown) => PrismaErrorTranslation> = {
  // A unique constraint rejected the write. In practice: two submissions that
  // raced, a reused short code, a second registration for the same Stellar
  // account. The client's request was fine; it is just not the first one.
  P2002: (meta) =>
    build(409, ErrorCode.DUPLICATE_RECORD, "A record with these values already exists.", "P2002", meta),

  // A value is longer than its column: truncation the schema forbids.
  P2000: (meta) => build(400, ErrorCode.VALIDATION_ERROR, "A value is too long for this field.", "P2000", meta),

  // The row this write points at does not exist. Referential integrity, not a
  // conflict: the reference itself is wrong.
  P2003: (meta) =>
    build(400, ErrorCode.VALIDATION_ERROR, "A referenced record does not exist.", "P2003", meta),

  // A check constraint (or exclusion constraint) rejected the value.
  P2004: (meta) =>
    build(400, ErrorCode.VALIDATION_ERROR, "A database constraint rejected this value.", "P2004", meta),

  // The value is outside the domain the column enforces.
  P2007: (meta) =>
    build(400, ErrorCode.VALIDATION_ERROR, "A value is not valid for this field.", "P2007", meta),

  // A NOT NULL column was left null.
  P2011: (meta) => build(400, ErrorCode.VALIDATION_ERROR, "A required field was missing.", "P2011", meta),

  // A value the query required was not supplied at all.
  P2012: (meta) => build(400, ErrorCode.VALIDATION_ERROR, "A required value was not provided.", "P2012", meta),

  // A required relation was not provided with the write.
  P2014: (meta) =>
    build(400, ErrorCode.VALIDATION_ERROR, "A required related record was not provided.", "P2014", meta),

  // A required record was not found — a row that disappeared between the read
  // and the write, or a route that required it.
  P2001: (meta) => build(404, ErrorCode.NOT_FOUND, "The record does not exist.", "P2001", meta),
  P2025: (meta) => build(404, ErrorCode.NOT_FOUND, "The record does not exist.", "P2025", meta),

  // Two transactions deadlocked or could not serialize. Genuinely transient:
  // the same request usually succeeds on a second attempt.
  P2034: (meta) =>
    build(409, ErrorCode.CONFLICT, "Concurrent update conflict. Please retry.", "P2034", meta, true),

  // Our own SQL: a query Prisma could not parse, or a raw statement the driver
  // rejected. Not the client's fault and not retryable, so it stays a 500 — but
  // with fixed text, because Prisma's message quotes the statement.
  P2008: (meta) => build(500, ErrorCode.INTERNAL_ERROR, "A database query failed.", "P2008", meta),
  P2010: (meta) => build(500, ErrorCode.INTERNAL_ERROR, "A database query failed.", "P2010", meta),
};

/**
 * `P1xxx` is Prisma's range for client-lifecycle failures: the database is
 * unreachable, the credentials were refused, the pool timed out, the server
 * closed the connection. All of them are the same answer for a caller — this
 * process cannot serve the request right now, and the same request may well
 * work once the database is. Matched as a range so a newer Prisma release
 * cannot turn a known outage into an untranslated 500.
 */
const LIFECYCLE_CODE = /^P1\d{3}$/;

/**
 * Prisma's own classes that carry no usable code. Named explicitly rather than
 * defaulted, so an unrelated exception is never mistaken for a database error.
 */
const NAMED_ERRORS: Record<string, () => PrismaErrorTranslation> = {
  // The message is the connection failure Prisma swallowed while retrying; the
  // driver's own text (host, port, credentials) is in it.
  PrismaClientInitializationError: () => ({
    status: 503,
    code: ErrorCode.SERVICE_UNAVAILABLE,
    message: "The database is temporarily unavailable. Please retry shortly.",
    prismaCode: "PrismaClientInitializationError",
    retryable: true,
  }),

  // A malformed query — ours, not the caller's. Fixed text: this message quotes
  // the query and its arguments, which is exactly the kind of value that must
  // not be echoed back.
  PrismaClientValidationError: () => ({
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: "A database query failed.",
    prismaCode: "PrismaClientValidationError",
    retryable: false,
  }),

  // A statement failed for a reason Prisma does not recognise. Not retryable
  // without knowing which — but still not a client error.
  PrismaClientUnknownRequestError: () => ({
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: "A database query failed.",
    prismaCode: "PrismaClientUnknownRequestError",
    retryable: false,
  }),
};

/**
 * Resolve an error to a database failure, or null if it is not one.
 *
 * Called by the central error handler before its generic fallbacks, so a
 * rejected write produces the same shaped response as any other client error
 * (or the correct 503 for an outage) while keeping its own code.
 */
export function toPrismaError(error: unknown): PrismaErrorTranslation | null {
  if (!error || typeof error !== "object") return null;

  const candidate = error as Record<string, unknown>;
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const named = NAMED_ERRORS[name];
  if (named) return named();

  // `PrismaClientKnownRequestError` uses `code`; the lifecycle errors use
  // `errorCode`. Accept either, so both halves of the vocabulary are covered.
  const code =
    typeof candidate.code === "string"
      ? candidate.code
      : typeof candidate.errorCode === "string"
        ? candidate.errorCode
        : "";

  if (LIFECYCLE_CODE.test(code)) {
    return {
      status: 503,
      code: ErrorCode.SERVICE_UNAVAILABLE,
      message: "The database is temporarily unavailable. Please retry shortly.",
      prismaCode: code,
      retryable: true,
    };
  }

  const resolve = KNOWN_REQUEST_ERRORS[code];
  return resolve ? resolve(candidate.meta) : null;
}
