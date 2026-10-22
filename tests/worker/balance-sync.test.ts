/**
 * Balance-sync worker task — error handling and retry behaviour (#645).
 *
 * `stellar.loadAccount` already retries the Horizon *read* internally, so the
 * task's job is what that wrapper cannot do: bound the retries it still owes
 * (the `accountBalance` upsert, and a read whose own budget re-threw), classify
 * the failure, and above all *account for it honestly*. The pre-#645 code
 * swallowed every per-account error in `syncAccountBalances`, so the outer loop
 * counted a hard failure as `synced` and `failed` never incremented — exactly
 * the "dropped tasks" the issue is about.
 *
 * These tests drive `withRetry` for real (only `pino`, `src/db`, and `stellar`
 * are mocked) so the transient-retry, transient-exhaustion, and permanent-
 * fail-fast paths are genuinely exercised, not stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    group: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    accountBalance: { upsert: vi.fn() },
  };
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return { prisma, logger, loadAccount: vi.fn() };
});

vi.mock("pino", () => ({ default: vi.fn(() => h.logger) }));
vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/stellar", () => ({
  stellar: { loadAccount: h.loadAccount },
}));

import {
  runBalanceSync,
  syncBalances,
} from "../../src/worker/tasks/balance-sync";

// Deterministic seams: no real backoff, no real inter-account throttle, and a
// small bounded budget so the exhaustion path is cheap to assert.
const NO_SLEEP = async (): Promise<void> => {};
const POLICY = { maxAttempts: 3, initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 };

const transient = () =>
  Object.assign(new Error("Horizon read failed"), { statusCode: 503 });
const permanent = () =>
  Object.assign(new Error("bad request"), { statusCode: 400 });

const snapshot = (balances: Array<{ assetCode: string; balance: string }>) => ({
  exists: true,
  balances,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.group.findMany.mockResolvedValue([]);
  h.prisma.user.findMany.mockResolvedValue([
    { id: "u1", stellarPublicKey: "GACCOUNT" },
  ]);
  h.prisma.accountBalance.upsert.mockResolvedValue({});
});

describe("balance-sync — transient retry (#645)", () => {
  it("retries a transient failure once and succeeds without counting it failed", async () => {
    let calls = 0;
    h.loadAccount.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw transient();
      return snapshot([{ assetCode: "USDC", balance: "10.0000000" }]);
    });
    const onRetry = vi.fn();

    const result = await syncBalances({
      requestDelayMs: 0,
      retryPolicy: POLICY,
      retrySleep: NO_SLEEP,
      onRetry,
    });

    expect(result).toEqual({ synced: 1, failed: 0 });
    // A retry genuinely happened (pre-fix this account would be synced without
    // ever being re-attempted) and the transient was logged, not buried.
    expect(h.loadAccount).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(h.prisma.accountBalance.upsert).toHaveBeenCalledTimes(1);
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("gives up after the transient budget and records the account as failed", async () => {
    h.loadAccount.mockRejectedValue(transient());
    const onRetry = vi.fn();

    const result = await syncBalances({
      requestDelayMs: 0,
      retryPolicy: POLICY,
      retrySleep: NO_SLEEP,
      onRetry,
    });

    expect(result).toEqual({ synced: 0, failed: 1 });
    // Bounded: exactly maxAttempts, never an infinite retry loop.
    expect(h.loadAccount).toHaveBeenCalledTimes(POLICY.maxAttempts);
    expect(onRetry).toHaveBeenCalledTimes(POLICY.maxAttempts - 1);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "transient",
        accountId: "GACCOUNT",
        type: "user",
      }),
      "failed to sync account permanently"
    );
  });
});

describe("balance-sync — permanent failure must not burn retries (#645)", () => {
  it("fails fast on a 4xx without re-attempting", async () => {
    h.loadAccount.mockRejectedValue(permanent());

    const result = await syncBalances({
      requestDelayMs: 0,
      retryPolicy: POLICY,
      retrySleep: NO_SLEEP,
    });

    expect(result).toEqual({ synced: 0, failed: 1 });
    // Permanent errors throw on the first attempt — the whole point of
    // classifyJobFailure. Retrying a 4xx is wasted work.
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ category: "permanent" }),
      "failed to sync account permanently"
    );
  });

  it("counts an exhausted transient budget in a `failed` total, never as `synced`", async () => {
    // The dropped-task regression itself: an all-failing cycle must report the
    // failures, not silently zero them out.
    h.loadAccount.mockRejectedValue(transient());

    const result = await syncBalances({
      requestDelayMs: 0,
      retryPolicy: POLICY,
      retrySleep: NO_SLEEP,
    });

    expect(result.failed).toBeGreaterThan(0);
    expect(result.synced).toBe(0);
  });
});

describe("balance-sync — non-error and multi-account paths (#645)", () => {
  it("treats a missing account as processed, not a failure, and writes nothing", async () => {
    h.loadAccount.mockResolvedValue({ exists: false, balances: [] });

    const result = await syncBalances({
      requestDelayMs: 0,
      retryPolicy: POLICY,
      retrySleep: NO_SLEEP,
    });

    expect(result).toEqual({ synced: 1, failed: 0 });
    expect(h.prisma.accountBalance.upsert).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "GACCOUNT" }),
      "account not found on Stellar network"
    );
  });

  it("returns zero counts when no accounts are active", async () => {
    h.prisma.user.findMany.mockResolvedValue([]);

    const result = await syncBalances({ retrySleep: NO_SLEEP });

    expect(result).toEqual({ synced: 0, failed: 0 });
    expect(h.loadAccount).not.toHaveBeenCalled();
  });

  it("isolates one account's failure so a sibling still syncs and counts split", async () => {
    h.prisma.user.findMany.mockResolvedValue([
      { id: "u1", stellarPublicKey: "GOK" },
      { id: "u2", stellarPublicKey: "GBAD" },
    ]);
    h.loadAccount.mockImplementation(async (publicKey: string) => {
      if (publicKey === "GBAD") throw permanent();
      return snapshot([{ assetCode: "USDC", balance: "5.0000000" }]);
    });

    const result = await syncBalances({
      requestDelayMs: 0,
      retryPolicy: POLICY,
      retrySleep: NO_SLEEP,
    });

    expect(result).toEqual({ synced: 1, failed: 1 });
    // The healthy account was not starved by the failing one.
    expect(h.prisma.accountBalance.upsert).toHaveBeenCalledTimes(1);
  });

  it("runBalanceSync wires syncBalances with production defaults", async () => {
    h.loadAccount.mockResolvedValue(
      snapshot([{ assetCode: "XLM", balance: "1.0000000" }])
    );

    await expect(runBalanceSync()).resolves.toBeUndefined();
    expect(h.prisma.accountBalance.upsert).toHaveBeenCalledTimes(1);
  });
});
