import { prisma } from "../db";
import { getFeeStats } from "./network";
import { anchorService } from "./anchor";

const CHECK_TIMEOUT_MS = 1_500;
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
