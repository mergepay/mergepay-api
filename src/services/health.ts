import { prisma } from "../db";
import { config } from "../config";
import { getFeeStats } from "./network";
import { anchorService } from "./anchor";

const CHECK_TIMEOUT_MS = 1_500;
const DEEP_CHECK_TIMEOUT_MS = 4_000;
const READINESS_CACHE_TTL_MS = 5_000;

type DependencyStatus = "up" | "down" | "disabled";

interface ReadinessChecks {
  database: DependencyStatus;
  stellar: DependencyStatus;
  anchor: DependencyStatus;
}

export interface ReadinessResponse {
  status: "ok" | "not_ready";
  checks: ReadinessChecks;
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

async function checkDatabase(): Promise<DependencyStatus> {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`);
    return "up";
  } catch {
    return "down";
  }
}

async function checkStellar(): Promise<DependencyStatus> {
  try {
    // getFeeStats uses the shared Horizon client and its existing short cache.
    await withTimeout(getFeeStats());
    return "up";
  } catch {
    return "down";
  }
}

async function checkAnchor(): Promise<DependencyStatus> {
  // The default application configuration supports deployments without an
  // anchor. Only explicitly configured anchors are required by readiness.
  const homeDomain = process.env.ANCHOR_HOME_DOMAIN?.trim();
  if (!homeDomain) return "disabled";

  try {
    await withTimeout(anchorService.getToml(homeDomain));
    return "up";
  } catch {
    return "down";
  }
}

async function performReadinessCheck(): Promise<ReadinessResponse> {
  const [database, stellar, anchor] = await Promise.all([
    checkDatabase(),
    checkStellar(),
    checkAnchor(),
  ]);

  const checks = { database, stellar, anchor };
  const ready = Object.values(checks).every(
    (status) => status === "up" || status === "disabled"
  );

  return {
    status: ready ? "ok" : "not_ready",
    checks,
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
