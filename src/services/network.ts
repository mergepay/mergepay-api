import { Horizon } from "@stellar/stellar-sdk";
import { config } from "../config";

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
  const response = await horizon().feeStats();
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
