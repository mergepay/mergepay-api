/**
 * Shared Pino logger factory.
 *
 * Every logger created through this module includes a custom serializer for
 * Stellar SDK error objects, so Horizon errors are consistently represented
 * across the API server (Fastify) and background workers.
 *
 * Workers and services that create their own `pino()` instances directly
 * should migrate to this factory to get the serializer automatically.
 */
import pino from "pino";
import { stellarErrorSerializer } from "./stellar-serializer";

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
 * Create a Pino logger with the Stellar error serializer registered.
 *
 * The serializer is attached under `serializers.err` so that any `err` field
 * passed to `.error()` / `.warn()` is automatically transformed — callers
 * do not need to do anything special.
 */
export function createLogger(options: LoggerOptions): pino.Logger {
  return pino({
    name: options.name,
    level: options.level,
    serializers: {
      err: stellarErrorSerializer,
    },
    ...options.opts,
  });
}
