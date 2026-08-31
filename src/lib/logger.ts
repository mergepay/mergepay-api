/**
 * Shared Pino logger factory.
 *
 * Every logger created through this module includes custom serializers for:
 *  - Stellar SDK error objects (`err`) — so Horizon errors are consistently
 *    represented across the API server and background workers.
 *  - Request objects (`req`) — sensitive headers (Authorization, Cookie) are
 *    redacted while method, URL, query, and telemetry headers are preserved.
 *  - Response objects (`res`) — the `set-cookie` header is redacted while
 *    statusCode and non-sensitive headers are preserved.
 *
 * Workers and services that create their own `pino()` instances directly
 * should migrate to this factory to get the serializers automatically.
 */
import pino from "pino";
import { stellarErrorSerializer } from "./stellar-serializer";
import { reqSerializer, resSerializer } from "./serializers";

/** Options accepted by the logger factory. */
export interface LoggerOptions {
  /** Logger name (appears as the `name` field in structured output). */
  name: string;
  /** Minimum log level. Falls back to the Pino default ("info"). */
  level?: string;
  /** Additional Pino options merged after the defaults. */
  opts?: Omit<pino.LoggerOptions, "name" | "level" | "serializers">;
}

/**
 * Create a Pino logger with custom serializers for Stellar errors, request
 * headers, and response headers.
 *
 * The `err` serializer is attached under `serializers.err` so that any `err`
 * field passed to `.error()` / `.warn()` is automatically transformed.
 *
 * The `req` and `res` serializers redact sensitive headers (Authorization,
 * Cookie, Set-Cookie) while preserving method, URL, query, request IDs, and
 * standard telemetry fields.
 */
export function createLogger(options: LoggerOptions): pino.Logger {
  return pino({
    name: options.name,
    level: options.level,
    serializers: {
      err: stellarErrorSerializer,
      req: reqSerializer,
      res: resSerializer,
    },
    ...options.opts,
  });
}
