import { Horizon } from "@stellar/stellar-sdk";
import { config } from "../config";
import { retryRead, withTimeout } from "./timeout";

/**
 * Retry bounds for the fee-stats read. Horizon is a read-only, idempotent
 * request that is safe to retry on transient network/server failures; the
 * bounds come from the same application configuration as every other timeout.
 */
const READ_RETRY_POLICY = {
  maxAttempts: config.HORIZON_READ_RETRY_MAX_ATTEMPTS,
  initialDelayMs: config.HORIZON_READ_RETRY_INITIAL_DELAY_MS,
  maxDelayMs: config.HORIZON_READ_RETRY_MAX_DELAY_MS,
};

export interface FeeStats {
  minAcceptedFee: number;
  modeAcceptedFee: number;
  p10: number;
  p20: number;
  p30: number;
  p40: number;
  p50: number;
  p60: number;
  p70: number;
  p80: number;
  p90: number;
  p99: number;
}

let server: Horizon.Server | null = null;
let cached: { stats: FeeStats; expiresAt: number } | null = null;
let refresh: Promise<FeeStats> | null = null;

function horizon(): Horizon.Server {
  if (!server) server = new Horizon.Server(config.HORIZON_URL);
  return server;
}

function fee(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function normalize(raw: Record<string, unknown>): FeeStats {
  return {
    minAcceptedFee: fee(raw.min_accepted_fee),
    modeAcceptedFee: fee(raw.mode_accepted_fee),
    p10: fee(raw.p10),
    p20: fee(raw.p20),
    p30: fee(raw.p30),
    p40: fee(raw.p40),
    p50: fee(raw.p50),
    p60: fee(raw.p60),
    p70: fee(raw.p70),
    p80: fee(raw.p80),
    p90: fee(raw.p90),
    p99: fee(raw.p99),
  };
}

async function fetchFeeStats(): Promise<FeeStats> {
  const response = await retryRead("Horizon.feeStats", READ_RETRY_POLICY, async (attempt) => {
    try {
      return await withTimeout(
        "Horizon.feeStats",
        config.HORIZON_FEE_TIMEOUT_MS,
        async (_signal) => {
          // Horizon.Server.feeStats doesn't accept AbortSignal directly,
          // but we wrap it so timeout still fires and rejects the promise.
          return horizon().feeStats();
        }
      );
    } catch (error) {
      // The inner withTimeout already classifies the failure; log the attempt
      // count as an operational breadcrumb without echoing any payload or
      // credentials, then let retryRead decide whether to retry or re-throw.
      console.error(
        `[network] Horizon.feeStats attempt ${attempt}/${READ_RETRY_POLICY.maxAttempts} failed`,
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  });
  const stats = normalize(response as unknown as Record<string, unknown>);
  cached = {
    stats,
    expiresAt: Date.now() + config.FEE_CACHE_TTL * 1000,
  };
  return stats;
}

/** Return Horizon fee statistics, refreshing the short-lived in-memory cache as needed. */
export async function getFeeStats(): Promise<FeeStats> {
  if (cached && cached.expiresAt > Date.now()) return cached.stats;

  if (!refresh) {
    refresh = fetchFeeStats().finally(() => {
      refresh = null;
    });
  }

  return refresh;
}

/** Clear cached fee statistics. Primarily useful for tests and explicit refreshes. */
export function clearFeeStatsCache(): void {
  cached = null;
}