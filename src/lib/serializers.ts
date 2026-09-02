/**
 * Custom Pino serializers for Fastify request and response objects.
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
 */

const REDACTED = "[REDACTED]" as const;

/**
 * Header names that carry authentication credentials or session tokens
 * and must never appear in log output.
 */
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
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
    headers: redactHeaders(res.headers),
  };
}
