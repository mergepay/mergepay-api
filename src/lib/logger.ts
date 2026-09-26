/**
 * Shared Pino logger factory and option set.
 *
 * Every logger created through this module — the Fastify instance in
 * `src/app.ts`, the audit-event stream, and any future worker or service
 * logger — is built from the same options, so a redaction rule or a serializer
 * is defined exactly once:
 *
 *  - Stellar SDK error objects (`err`) — Horizon errors are consistently
 *    represented across the API server and background workers.
 *  - Request objects (`req`) — sensitive headers (Authorization, Cookie) are
 *    redacted while method, URL, query, request id, and telemetry headers are
 *    preserved.
 *  - Response objects (`res`) — the `set-cookie` header is redacted while
 *    statusCode and non-sensitive headers are preserved.
 *  - Credential-shaped top-level fields (`redact`) — a token or private key
 *    logged as its own key is censored even if it never passes through a
 *    serializer.
 *
 * Workers and services that create their own `pino()` instances directly
 * should migrate to this factory to get the serializers automatically.
 */
import pino from "pino";
import type { LoggerOptions as PinoLoggerOptions } from "pino";
import type { FastifyLoggerOptions } from "fastify";
import { Writable } from "node:stream";
import { errorSerializer, reqSerializer, resSerializer } from "./serializers";

/**
 * The serializer map attached to every logger this module builds.
 *
 * Registered under Pino's standard field names, which is what makes them apply
 * without call-site discipline: any `log.info({ req }, …)` or
 * `log.error({ err }, …)` anywhere in the codebase is formatted by these
 * functions, including the request and response logging Fastify emits itself.
 */
export const LOGGER_SERIALIZERS = {
  err: errorSerializer,
  req: reqSerializer,
  res: resSerializer,
} satisfies Record<string, pino.SerializerFn>;

/** Replacement written in place of a redacted value. */
export const REDACT_CENSOR = "[REDACTED]";

/**
 * Field paths censored by Pino itself.
 *
 * The serializers already redact credentials inside `req`/`res`/`err`; these
 * paths are the second line of defence for the values a call site logs
 * directly, outside any of those fields — `log.info({ token }, …)`, a request
 * body, or a signed envelope echoed into an error payload.
 */
export const REDACT_PATHS: string[] = [
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "authorization",
  "cookie",
  "token",
  "accessToken",
  "refreshToken",
  "signedXdr",
  "transactionXdr",
  "privateKey",
  "secret",
  "password",
  "body.token",
  "body.signedXdr",
  "body.transactionXdr",
  "body.privateKey",
  "body.password",
];

/** Redaction config shared by every logger this module builds. */
export function redactOptions(): { paths: string[]; censor: string } {
  // A fresh array per logger: Pino compiles these paths into its own redaction
  // state, and a shared array would let one logger's configuration leak into
  // another's.
  return { paths: [...REDACT_PATHS], censor: REDACT_CENSOR };
}

/**
 * The option object Fastify accepts for `logger`: Fastify's own logger options
 * (which type the `req`/`res`/`err` serializer signatures) intersected with
 * Pino's (which adds `redact`, `transport`, and friends).
 */
export type LoggerConfig = FastifyLoggerOptions & PinoLoggerOptions;

/** Options accepted by {@link buildLoggerOptions}. */
export interface LoggerOptionOverrides {
  /** Minimum level. `"silent"` keeps the pipeline live but emits nothing. */
  level: string;
  /** Route development output through `pino-pretty` for human-readable logs. */
  pretty?: boolean;
}

/**
 * The Pino options for the Fastify instance.
 *
 * One builder, two destinations: `buildApp` hands the result to Fastify, and a
 * test that owns its own capture stream hands the very same object to `pino()`
 * directly — so what the suite asserts on is the configuration production runs
 * with, not a copy of it.
 */
export function buildLoggerOptions(overrides: LoggerOptionOverrides): LoggerConfig {
  return {
    level: overrides.level,
    // Fastify narrows `serializers` to the shapes of its own default
    // serializers, so its declared types reject ours even though Pino only
    // requires `(value: any) => any`. The cast is at that boundary, not on the
    // serializers themselves.
    serializers: LOGGER_SERIALIZERS as unknown as LoggerConfig["serializers"],
    redact: redactOptions(),
    ...(overrides.pretty
      ? { transport: { target: "pino-pretty", options: { colorize: true } } }
      : {}),
  };
}

/**
 * A destination that discards everything written to it.
 *
 * Used by the test suite: the serializers and the redaction rules still run on
 * every line, so a serializer that throws or a credential that escapes
 * redaction fails `npm test` — while `npm test` itself stays quiet.
 */
export function nullLogDestination(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

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
 * headers, and response headers, plus the shared redaction rules.
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
    serializers: LOGGER_SERIALIZERS,
    redact: redactOptions(),
    ...options.opts,
  });
}
