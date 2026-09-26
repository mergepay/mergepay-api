/**
 * Custom Pino serializers for Fastify request, response, and error objects.
 *
 * Pino's default `req`/`res` serializers copy every header verbatim, which
 * means Authorization tokens, SEP-10 JWTs, session cookies, and other
 * credentials leak into structured log output. These serializers:
 *
 *  1. Redact known-sensitive headers (`authorization`, `cookie`, `set-cookie`)
 *     with a `[REDACTED]` sentinel so the field presence is still visible
 *     but the value is not.
 *  2. Preserve request IDs (`x-request-id`, `x-correlation-id`) and standard
 *     telemetry headers (`user-agent`, `accept`, `content-type`) so debugging
 *     and observability are not degraded.
 *  3. Keep the same top-level shape as Pino's built-in serializers (`method`,
 *     `url`, `headers`, `query` for req; `statusCode`, `headers` for res)
 *     so existing log consumers do not break.
 *
 * The error serializer follows the same principle for the `err` field: it
 * flattens an error to the fields that actually help an on-call engineer
 * (`code`, `statusCode`, `requestId`, a stack) instead of dumping every own
 * property, and scrubs credential-shaped keys from whatever detail payload the
 * error carries. Both rules exist to serve the same goal: a log line that is
 * small enough to read and free of secrets.
 *
 * Every serializer here is a total function. Pino calls them from inside its
 * write path, so a throw (or a circular reference) would corrupt the log line
 * — and, in the request path, the response.
 */

import { isStellarError, stellarErrorSerializer, type StellarSerializedError } from "./stellar-serializer";

const REDACTED = "[REDACTED]" as const;

/** Value written in place of a structure too deep or too tangled to serialize. */
const TRUNCATED = "[TRUNCATED]" as const;
const CIRCULAR = "[CIRCULAR]" as const;

/** How deep the error detail payload is followed before it is cut off. */
const MAX_DETAIL_DEPTH = 4;

/**
 * Header names that carry authentication credentials or session tokens
 * and must never appear in log output.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
]);

/**
 * Keys that carry credentials anywhere in a serialized structure — not just in
 * a header map. Applied to the nested detail payloads that errors, workers, and
 * services attach, where a `token` or a signed envelope can appear under
 * whatever key the throwing code chose (`err.details.*`, `err.context.*`, …).
 *
 * Matching is case-insensitive and by exact key name, so the camelCase and
 * snake_case spellings in use are both listed.
 */
const SENSITIVE_KEYS = new Set([
  ...SENSITIVE_HEADERS,
  "token",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "idtoken",
  "jwt",
  "secret",
  "clientsecret",
  "password",
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic",
  "apikey",
  "xdr",
  "signedxdr",
  "transactionxdr",
]);

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Shallow-clone a headers object, replacing values of sensitive keys with
 * the redacted sentinel. Preserves header casing from the original object.
 */
function redactHeaders(
  headers: Record<string, string | string[] | undefined> | undefined
): Record<string, string | string[] | undefined> {
  if (!headers || typeof headers !== "object") return {};

  const sanitized: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
      sanitized[key] = REDACTED;
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// ─── request serializer ─────────────────────────────────────────────────────

/**
 * Shape returned by the request serializer — matches Pino's built-in
 * `req` serializer contract so downstream consumers (pino-pretty, log
 * aggregators, dashboards) continue to work unchanged.
 */
export interface SerializedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  /** The request id, when the caller logged a request outside a request scope. */
  id?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  remoteAddress?: string;
  remotePort?: number;
}

/**
 * Pino-compatible serializer for Fastify / Node.js incoming requests.
 *
 * Sensitive headers are replaced with `[REDACTED]`. All other fields are
 * copied verbatim. The serializer is idempotent — passing an already-
 * serialized object is safe.
 */
export function reqSerializer(req: any): SerializedRequest {
  if (!req || typeof req !== "object") {
    return { method: "UNKNOWN", url: "UNKNOWN", headers: {} };
  }

  const serialized: SerializedRequest = {
    method: req.method ?? "UNKNOWN",
    url: req.url ?? "UNKNOWN",
    headers: redactHeaders(req.headers),
  };

  if (req.query && typeof req.query === "object") {
    serialized.query = req.query;
  }
  if (req.params && typeof req.params === "object") {
    serialized.params = req.params;
  }
  // Pino maps an incoming request to a plain object before handing it to this
  // serializer, and that mapping is where the request id lives. Inside a request
  // the id also rides on the child logger's bindings, so this is the fallback
  // that keeps a `{ req }` logged outside that scope correlatable.
  if (typeof req.id === "string" && req.id) {
    serialized.id = req.id;
  }
  if (req.remoteAddress) {
    serialized.remoteAddress = req.remoteAddress;
  }
  if (req.remotePort) {
    serialized.remotePort = req.remotePort;
  }

  return serialized;
}

// ─── response serializer ────────────────────────────────────────────────────

/**
 * Shape returned by the response serializer — mirrors Pino's built-in
 * `res` contract.
 */
export interface SerializedResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * The headers of an outgoing response, read from whichever accessor the object
 * in hand exposes.
 *
 * Pino hands this serializer the Fastify reply itself, not a Node response, and
 * a reply keeps its headers behind `getHeaders()` — so reading `res.headers`
 * alone would find nothing and `set-cookie` would never be seen, let alone
 * redacted. `getHeaders()` reads the raw socket, which is unavailable for a
 * reply whose response was never opened (and throws on a torn-down one), hence
 * the guard: a log line must not be lost to an error raised while serializing
 * it.
 */
function responseHeaders(
  res: Record<string, any>
): Record<string, string | string[] | undefined> {
  if (res.headers && typeof res.headers === "object") {
    return redactHeaders(res.headers);
  }
  if (typeof res.getHeaders === "function") {
    try {
      return redactHeaders(res.getHeaders());
    } catch {
      return {};
    }
  }
  return {};
}

/**
 * Pino-compatible serializer for Fastify / Node.js outgoing responses.
 *
 * The `set-cookie` header (which may contain session or SEP-10 tokens) is
 * redacted. `statusCode` and all non-sensitive headers are preserved.
 */
export function resSerializer(res: any): SerializedResponse {
  if (!res || typeof res !== "object") {
    return { statusCode: 0, headers: {} };
  }

  return {
    statusCode: typeof res.statusCode === "number" ? res.statusCode : 0,
    headers: responseHeaders(res),
  };
}

// ─── error serializer ───────────────────────────────────────────────────────

/**
 * Shape returned by the error serializer.
 *
 * It extends the Stellar shape so a Horizon failure keeps its problem-detail
 * fields (`title`, `detail`, result codes) alongside the application fields the
 * API needs to triage a rejection: the machine-readable `code`, the HTTP
 * `statusCode`, and the `requestId` that ties the line to a request.
 */
export interface SerializedError extends StellarSerializedError {
  code?: string;
  requestId?: string;
  correlationId?: string;
  /** The upstream operation an error was raised by, when it names one. */
  operation?: string;
  details?: unknown;
}

/**
 * Recursively copy a value for logging: credential-shaped keys are redacted,
 * `Date`s become ISO strings, and nesting is bounded by both a depth limit and
 * a cycle guard.
 *
 * The guard matters because Pino hands the serializer's return value straight to
 * `JSON.stringify`; a self-referencing detail payload would otherwise throw
 * there and take the surrounding log line — and the request that produced it —
 * down with it.
 */
function sanitizeForLog(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): unknown {
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return value.toISOString();
  if (depth >= MAX_DETAIL_DEPTH) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  try {
    if (value instanceof Error) {
      // A nested error (`cause`, or an error inside a detail payload) is reduced
      // to its headline. Its own detail payload is walked with this call's depth
      // and cycle guard, so a chain of errors that points back at itself stops
      // here instead of exhausting the stack.
      return { ...errorHeadline(value), ...applicationErrorFields(value, depth + 1, seen) };
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeForLog(item, depth + 1, seen));
    }

    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? REDACTED
        : sanitizeForLog(item, depth + 1, seen);
    }
    return sanitized;
  } finally {
    // Released on the way out so a value referenced twice in the same payload
    // is serialized twice; only a reference back into the current path (a real
    // cycle) is reported as circular.
    seen.delete(value);
  }
}

/**
 * The `type` / `name` / `message` / `stack` headline of a thrown value.
 *
 * `type` and `stack` are always strings because that is the contract Pino and
 * Fastify's own error handling expect of a serialized error; a thrown plain
 * object has neither, so both fall back rather than being left undefined.
 */
function errorHeadline(error: object): {
  type: string;
  name: string;
  message: string;
  stack: string;
} {
  const candidate = error as Record<string, unknown>;
  const name = typeof candidate.name === "string" && candidate.name ? candidate.name : "Error";

  return {
    type: name,
    name,
    message: typeof candidate.message === "string" ? candidate.message : String(error),
    stack: typeof candidate.stack === "string" ? candidate.stack : "",
  };
}

/**
 * The application-level fields worth keeping on any error, whatever its class.
 *
 * Every field is read defensively: these come from thrown values that this
 * module did not construct (Fastify, `@fastify/*`, the Stellar SDK, upstream
 * fetch failures), so each one is type-checked before it is trusted.
 */
function applicationErrorFields(
  error: object,
  depth = 0,
  seen: WeakSet<object> = new WeakSet<object>()
): Partial<SerializedError> {
  const candidate = error as Record<string, unknown>;
  const fields: Partial<SerializedError> = {};

  if (typeof candidate.code === "string" && candidate.code) {
    fields.code = candidate.code;
  }
  // `status` is AppError's own field; `statusCode` is the mirror Fastify and
  // the Stellar SDK use. Either may be a string on an upstream error, so only
  // real numbers are carried over.
  const statusCode =
    typeof candidate.statusCode === "number"
      ? candidate.statusCode
      : typeof candidate.status === "number"
        ? candidate.status
        : undefined;
  if (statusCode !== undefined) {
    fields.statusCode = statusCode;
  }
  if (typeof candidate.requestId === "string" && candidate.requestId) {
    fields.requestId = candidate.requestId;
  }
  if (typeof candidate.correlationId === "string" && candidate.correlationId) {
    fields.correlationId = candidate.correlationId;
  }
  if (typeof candidate.operation === "string" && candidate.operation) {
    fields.operation = candidate.operation;
  }
  if (candidate.details !== undefined) {
    fields.details = sanitizeForLog(candidate.details, depth, seen);
  }

  return fields;
}

/**
 * Pino-compatible serializer for errors passed as the `err` field.
 *
 * A Horizon failure is delegated to {@link stellarErrorSerializer}, which knows
 * how to flatten problem details and transaction result codes, and the
 * application fields are merged on top. Everything else — `AppError`, Fastify
 * errors, `ZodError`, plain `Error`, a thrown string — is reduced to `type`,
 * `message`, `stack`, plus whichever of `code` / `statusCode` / `requestId` /
 * `details` it happens to carry.
 *
 * Fields are an allowlist rather than a copy of every own property: an error
 * from a dependency can hold an entire request or response body, and dumping it
 * is exactly the log bloat this serializer exists to prevent. Whatever survives
 * is scrubbed of credential-shaped keys first.
 */
export function errorSerializer(error: unknown): SerializedError {
  if (error === null || error === undefined || typeof error !== "object") {
    return { message: String(error), type: "Error", stack: "" };
  }

  if (isStellarError(error)) {
    return { ...stellarErrorSerializer(error), ...applicationErrorFields(error) };
  }

  return { ...errorHeadline(error), ...applicationErrorFields(error) };
}

// ─── Stellar transaction hash serializer ────────────────────────────────────

/**
 * Number of hexadecimal characters in a Stellar transaction hash.
 *
 * A Stellar transaction hash is the SHA-256 digest of the transaction
 * envelope, so it is always exactly 32 bytes rendered as 64 hex characters
 * (e.g. Horizon's `hash` field and `Transaction.hash()` both produce this
 * shape).
 */
export const STELLAR_TX_HASH_HEX_LENGTH = 64;

/** Exact shape of a well-formed Stellar transaction hash. */
const STELLAR_TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/** Leading characters kept when shortening a valid hash for logs. */
const TX_HASH_HEAD = 8;

/** Trailing characters kept when shortening a valid hash for logs. */
const TX_HASH_TAIL = 8;

/** Emitted for `null` / `undefined` hash fields. */
export const MISSING_TX_HASH = "[missing-tx-hash]";

/** Emitted for non-string or structurally-invalid hash fields. */
export const INVALID_TX_HASH = "[invalid-tx-hash]";

/**
 * Type guard: is `value` a well-formed Stellar transaction hash?
 *
 * Surrounding whitespace is tolerated (anchors and clients sometimes pad
 * values) and the hash is matched case-insensitively — Stellar emits
 * lowercase, but uppercase hex is accepted and normalized downstream.
 */
export function isStellarTxHash(value: unknown): value is string {
  return typeof value === "string" && STELLAR_TX_HASH_PATTERN.test(value.trim());
}

/**
 * Shorten a validated transaction hash for human-readable log output:
 * `abc12345…6789def0`. Short inputs are returned untouched so the helper
 * cannot mangle a value it was never meant to transform.
 */
export function truncateStellarTxHash(hash: string): string {
  const normalized = hash.trim();
  if (normalized.length <= TX_HASH_HEAD + TX_HASH_TAIL) return normalized;
  return `${normalized.slice(0, TX_HASH_HEAD)}…${normalized.slice(-TX_HASH_TAIL)}`;
}

/**
 * Pino-compatible serializer for Stellar transaction hashes.
 *
 * Raw transaction objects and full 64-character hashes clutter structured log
 * output. This serializer validates the value, normalizes it to lowercase, and
 * shortens it to an `xxxxxxxx…xxxxxxxx` form. Malformed values never throw and
 * are replaced with a sentinel so the field is still visible without echoing
 * untrusted input into the logs.
 *
 * Non-string values (including `null`) are collapsed to a sentinel rather than
 * stringified — a serialized object or `"undefined"` would be both noisy and
 * misleading about which hash a log line refers to.
 */
export function txHashSerializer(value: unknown): string {
  if (value === null || value === undefined) return MISSING_TX_HASH;
  if (typeof value !== "string") return INVALID_TX_HASH;
  if (!isStellarTxHash(value)) return INVALID_TX_HASH;
  return truncateStellarTxHash(value.trim().toLowerCase());
}

/**
 * Pino `serializers` entries for the field names Stellar hashes travel under
 * across the API server and workers.
 *
 * Spread this into a Pino `serializers` map (or a Fastify `logger.serializers`
 * config) so every Stellar hash field is normalized and shortened
 * automatically. Pino only invokes a serializer for the exact key it is
 * registered under, so each known alias is listed explicitly.
 */
export const stellarTxHashSerializers: Record<
  string,
  (value: unknown) => string
> = {
  txHash: txHashSerializer,
  stellarTxHash: txHashSerializer,
  intendedTxHash: txHashSerializer,
  transactionHash: txHashSerializer,
  stellarTransactionHash: txHashSerializer,
};
