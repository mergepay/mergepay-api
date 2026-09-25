import { prisma } from "../db";
import { config } from "../config";
import { getFeeStats } from "./network";

const CHECK_TIMEOUT_MS = 5_000;
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

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("health check timeout")), CHECK_TIMEOUT_MS);
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Lightweight database ping helper that executes a simple query (SELECT 1) with a timeout
 * to verify active PostgreSQL connectivity. Returns `true` on success, or
 * `false` on any failure or timeout instead of throwing uncaught exceptions.
 */
export async function checkDatabaseConnection(
  client: any = prisma,
  timeoutMs: number = CHECK_TIMEOUT_MS
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const queryPromise =
      typeof client.$queryRawUnsafe === "function"
        ? client.$queryRawUnsafe("SELECT 1")
        : typeof client.$queryRaw === "function"
          ? client.$queryRaw`SELECT 1`
          : Promise.reject(new Error("No queryRaw method on prisma client"));

    await Promise.race([
      Promise.resolve(queryPromise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Database health check timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export const checkDatabase = checkDatabaseConnection;

export async function checkStellar(): Promise<boolean> {
  try {
    // getFeeStats uses the shared Horizon client and its existing short cache.
    await withTimeout(getFeeStats());
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
 * Race a promise against a timeout. Returns the result on success,
 * or `null` if the operation fails or times out.
 */
async function checkWithTimeout<T>(operation: Promise<T>): Promise<{ result: T; latencyMs: number } | null> {
  const start = Date.now();
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), DEEP_CHECK_TIMEOUT_MS)
      ),
    ]);
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
    checkWithTimeout(prisma.$queryRaw`SELECT 1`),
    checkWithTimeout(getFeeStats()),
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
