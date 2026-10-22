/**
 * Startup database connection with retry.
 *
 * In container deployments the API and worker routinely start before
 * PostgreSQL accepts connections. Prisma connects lazily, so without an
 * explicit connect the first request fails instead; with a bare
 * `$connect()` the process exits on the first refused connection. This waits
 * for the database with bounded exponential backoff, and gives up quickly on
 * errors retrying cannot fix (bad credentials, invalid schema).
 */

import { config } from "../config";
import { retryDelayMs, type RetryPolicy } from "../services/job-retry";

/** Prisma error codes where another attempt cannot succeed. */
const NON_RETRYABLE_CODES = new Set([
  "P1000", // authentication failed
  "P1010", // access denied
  "P1012", // schema validation error
]);

export interface ConnectableClient {
  $connect(): Promise<void>;
}

export interface ConnectLogger {
  warn(obj: object, msg: string): void;
  info(obj: object, msg: string): void;
}

export interface ConnectWithRetryOptions {
  policy?: RetryPolicy;
  logger?: ConnectLogger;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function dbConnectPolicy(): RetryPolicy {
  return {
    maxAttempts: config.DB_CONNECT_MAX_ATTEMPTS,
    initialDelayMs: config.DB_CONNECT_INITIAL_DELAY_MS,
    maxDelayMs: config.DB_CONNECT_MAX_DELAY_MS,
    jitterRatio: 0.2,
  };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { errorCode?: unknown; code?: unknown } | null)?.errorCode ??
    (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

export function isRetryableConnectError(error: unknown): boolean {
  const code = errorCode(error);
  return !(code && NON_RETRYABLE_CODES.has(code));
}

// Only the message and code are logged: a Prisma init error can echo the
// connection string, so the raw error object is never passed to the logger.
function describe(error: unknown): { code?: string; reason: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: errorCode(error),
    reason: message.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://***"),
  };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Connect `client`, retrying transient failures. Resolves once connected;
 * rejects with the last error when attempts run out or the error is
 * non-retryable.
 */
export async function connectWithRetry(
  client: ConnectableClient,
  options: ConnectWithRetryOptions = {}
): Promise<void> {
  const policy = options.policy ?? dbConnectPolicy();
  const sleep = options.sleep ?? defaultSleep;
  const logger = options.logger;

  for (let attempt = 1; ; attempt++) {
    try {
      await client.$connect();
      logger?.info({ attempt }, "database connected");
      return;
    } catch (error) {
      const retryable = isRetryableConnectError(error);
      if (!retryable || attempt >= policy.maxAttempts) {
        logger?.warn(
          { attempt, maxAttempts: policy.maxAttempts, retryable, ...describe(error) },
          "database connection failed; giving up"
        );
        throw error;
      }
      const delayMs = retryDelayMs(attempt, policy, options.random);
      logger?.warn(
        { attempt, maxAttempts: policy.maxAttempts, delayMs, ...describe(error) },
        "database connection failed; retrying"
      );
      await sleep(delayMs);
    }
  }
}
