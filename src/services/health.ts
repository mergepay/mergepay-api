import { prisma } from "../db";
import { config } from "../config";
import { getFeeStats } from "./network";
import { withTimeout } from "./timeout";

// Overall deadline for a single readiness probe.
const CHECK_TIMEOUT_MS = 5_000;
// Short deadline for the Prisma connectivity probe (`SELECT 1`). Kept well
// below the readiness deadline so a degraded database — a stalled query, an
// exhausted connection pool — is reported unhealthy quickly instead of
// blocking the health check (and its worker thread) for the full 5s.
const DB_HEALTH_CHECK_TIMEOUT_MS = 2_000;
const DEEP_CHECK_TIMEOUT_MS = 5_000;
const READINESS_CACHE_TTL_MS = 5_000;

export interface ReadinessResponse {
  status: "ok" | "degraded";
  database: { connected: boolean };
  stellar: { reachable: boolean; network: string };
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Deep health check
// ---------------------------------------------------------------------------

interface DependencyHealth {
  status: "up" | "down";
  latencyMs: number;
}

interface DeepHealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  uptime: number;
  checks: {
    database: DependencyHealth;
    stellar: DependencyHealth;
  };
  environment: {
    nodeEnv: string;
    stellarNetwork: string;
  };
}

let cached: { response: ReadinessResponse; expiresAt: number } | null = null;
let inFlight: Promise<ReadinessResponse> | null = null;

/**
 * Cheap liveness probe for the database. Never throws — an unreachable or
 * timed-out database is reported as `false`, not as an error to the caller.
 *
 * The `SELECT 1` probe is wrapped in a short timeout so that a stalled
 * connection fails the readiness check fast rather than hanging it.
 *
 * @returns `true` when `SELECT 1` answers within the readiness deadline.
 */
export async function checkDatabase(): Promise<boolean> {
  try {
    const ping =
      typeof prisma.$queryRawUnsafe === "function"
        ? () => prisma.$queryRawUnsafe("SELECT 1")
        : typeof prisma.$queryRaw === "function"
          ? () => prisma.$queryRaw`SELECT 1`
          : () => Promise.reject(new Error("No queryRaw method on prisma client"));

    await withTimeout(
      "database health check",
      DB_HEALTH_CHECK_TIMEOUT_MS,
      () => ping()
    );
    return true;
  } catch {
    return false;
  }
}

export const checkDatabaseConnection = checkDatabase;

/**
 * Probe Horizon through the shared fee-stats client (and its short cache) so
 * a readiness check costs no extra Horizon traffic in the common case. Every
 * failure mode — timeout, connection refusal, `upstream` error — is reported
 * as `false` rather than thrown — the health route reports dependency state
 * instead of failing on it.
 *
 * @returns `true` when Horizon answered within the readiness deadline.
 */
export async function checkStellar(): Promise<boolean> {
  try {
    // getFeeStats uses the shared Horizon client and its existing short cache.
    await withTimeout("stellar health check", CHECK_TIMEOUT_MS, () => getFeeStats());
    return true;
  } catch {
    return false;
  }
}

async function performReadinessCheck(): Promise<ReadinessResponse> {
  const [dbResult, stellarResult] = await Promise.allSettled([
    checkDatabase(),
    checkStellar(),
  ]);

  const database = dbResult.status === "fulfilled" && dbResult.value;
  const stellar = stellarResult.status === "fulfilled" && stellarResult.value;

  const status: "ok" | "degraded" = database && stellar ? "ok" : "degraded";

  return {
    status,
    database: { connected: database },
    stellar: { reachable: stellar, network: config.STELLAR_NETWORK },
    timestamp: new Date().toISOString(),
  };
}

export async function getReadiness(): Promise<ReadinessResponse> {
  if (cached && cached.expiresAt > Date.now()) return cached.response;

  if (!inFlight) {
    inFlight = performReadinessCheck()
      .then((response) => {
        cached = { response, expiresAt: Date.now() + READINESS_CACHE_TTL_MS };
        return response;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}

export function clearReadinessCache(): void {
  cached = null;
}

// ---------------------------------------------------------------------------
// Deep health — detailed dependency status with latency measurements
// ---------------------------------------------------------------------------

/**
 * Race a dependency probe against its timeout. Returns the result and the
 * measured latency on success, or `null` if the operation fails or times out.
 */
async function checkWithTimeout<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<{ result: T; latencyMs: number } | null> {
  const start = Date.now();
  try {
    const result = await withTimeout(operation, DEEP_CHECK_TIMEOUT_MS, () => fn());
    return { result, latencyMs: Date.now() - start };
  } catch {
    return null;
  }
}

/**
 * Perform a deep health check across all critical dependencies.
 *
 * Returns latency measurements and status for database and Horizon,
 * plus environment metadata. The `status` field is "ok" when both
 * critical dependencies are reachable, "degraded" otherwise.
 *
 * No secrets, connection strings, or internal infrastructure details
 * are included in the response.
 */
export async function getDeepHealth(): Promise<DeepHealthResponse> {
  const [dbResult, stellarResult] = await Promise.all([
    checkWithTimeout("database deep health check", () => prisma.$queryRaw`SELECT 1`),
    checkWithTimeout("stellar deep health check", () => getFeeStats()),
  ]);

  return {
    status: dbResult && stellarResult ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    checks: {
      database: {
        status: dbResult ? "up" : "down",
        latencyMs: dbResult?.latencyMs ?? -1,
      },
      stellar: {
        status: stellarResult ? "up" : "down",
        latencyMs: stellarResult?.latencyMs ?? -1,
      },
    },
    environment: {
      nodeEnv: config.NODE_ENV,
      stellarNetwork: config.STELLAR_NETWORK,
    },
  };
}
