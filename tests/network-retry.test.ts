import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * `getFeeStats` is the read-only Horizon operation the health readiness check
 * and fee lookups depend on. These tests exercise the *real* `network.getFeeStats`
 * path — including its bounded retry of transient failures — by mocking only the
 * SDK's Horizon client, never the service under test.
 *
 * Submission paths deliberately do not go through `retryRead` (see
 * timeout.test.ts); here we only verify the fetch-number bounds on the read.
 */

const mocks = vi.hoisted(() => ({
  feeStats: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: class {
        feeStats() {
          return mocks.feeStats();
        }
      },
    },
  };
});

// Fresh modules each test so the fee cache and `refresh` dedupe do not leak
// between cases.
beforeEach(() => {
  vi.resetModules();
  mocks.feeStats.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const HAPPY_STATS = {
  min_accepted_fee: "100",
  mode_accepted_fee: "200",
  p10: "100",
  p20: "110",
  p30: "120",
  p40: "130",
  p50: "140",
  p60: "150",
  p70: "160",
  p80: "170",
  p90: "180",
  p99: "190",
};

describe("network.getFeeStats read retry", () => {
  it("returns fee stats on the first attempt when Horizon is healthy", async () => {
    mocks.feeStats.mockResolvedValue(HAPPY_STATS);

    const { getFeeStats, clearFeeStatsCache } = await import("../src/services/network");
    clearFeeStatsCache();

    const stats = await getFeeStats();
    expect(stats.modeAcceptedFee).toBe(200);
    expect(mocks.feeStats).toHaveBeenCalledTimes(1);
  });

  it("retries a transient failure and succeeds on a later attempt", async () => {
    // A socket reset surfaces inside withTimeout as a TransportError.
    mocks.feeStats
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue(HAPPY_STATS);

    const { getFeeStats, clearFeeStatsCache } = await import("../src/services/network");
    clearFeeStatsCache();

    const stats = await getFeeStats();
    expect(stats.modeAcceptedFee).toBe(200);
    expect(mocks.feeStats).toHaveBeenCalledTimes(3);
  });

  it("gives up after the bounded retry budget is exhausted", async () => {
    mocks.feeStats.mockRejectedValue(new Error("ECONNREFUSED"));

    const { getFeeStats, clearFeeStatsCache } = await import("../src/services/network");
    clearFeeStatsCache();

    await expect(getFeeStats()).rejects.toBeDefined();
    // maxAttempts = 3 by default: the first call plus two retries.
    expect(mocks.feeStats).toHaveBeenCalledTimes(3);
  });
});
