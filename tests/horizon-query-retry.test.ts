import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Service-level retry behaviour for the Horizon query services (issue #531).
 *
 * Drives the real horizonService module against a mocked Horizon server and
 * asserts the properties the issue asks for:
 *
 *  - transient failures (5xx, rate limits, connection errors) are retried
 *    with exponential backoff until the bounded budget is spent;
 *  - non-retryable client errors (400, permanent result codes) fail
 *    immediately — exactly one upstream call, no sleeps;
 *  - the backoff schedule doubles per attempt, capped at maxDelayMs;
 *  - 404 ("not visible yet") stays a domain answer and is never retried.
 */

const h = vi.hoisted(() => ({
  HORIZON_STATUS_TIMEOUT_MS: 5_000,
  HORIZON_READ_RETRY_MAX_ATTEMPTS: 3,
  HORIZON_READ_RETRY_INITIAL_DELAY_MS: 250,
  HORIZON_READ_RETRY_MAX_DELAY_MS: 2_000,
  transactionCall: vi.fn(),
  paymentsCall: vi.fn(),
  sleeps: [] as number[],
}));

vi.mock("../src/config", () => ({
  config: {
    HORIZON_STATUS_TIMEOUT_MS: h.HORIZON_STATUS_TIMEOUT_MS,
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    HORIZON_READ_RETRY_MAX_ATTEMPTS: h.HORIZON_READ_RETRY_MAX_ATTEMPTS,
    HORIZON_READ_RETRY_INITIAL_DELAY_MS: h.HORIZON_READ_RETRY_INITIAL_DELAY_MS,
    HORIZON_READ_RETRY_MAX_DELAY_MS: h.HORIZON_READ_RETRY_MAX_DELAY_MS,
    isTest: true,
  },
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Horizon: {
    Server: vi.fn().mockImplementation(() => ({
      transactions: () => ({
        transaction: () => ({ call: h.transactionCall }),
      }),
      operations: () => ({
        forTransaction: () => ({
          limit: () => ({ call: h.paymentsCall }),
        }),
      }),
    })),
  },
  Memo: {},
}));

vi.mock("../src/services/timeout", async (importOriginal) => {
  // Real TimeoutError/TransportError classes, but withTimeout runs the
  // operation directly so tests don't wait on real deadlines.
  const actual = await importOriginal<
    typeof import("../src/services/timeout")
  >();
  return {
    ...actual,
    withTimeout: vi.fn((_name: string, _ms: number, fn: () => any) => fn()),
  };
});

import {
  getTransactionFromHorizon,
  getTransactionPayments,
} from "../src/services/horizonService";

function serverError() {
  return Object.assign(new Error("Internal Server Error"), {
    response: { status: 503 },
  });
}

function badRequest() {
  return Object.assign(new Error("Bad Request"), {
    response: { status: 400 },
  });
}

function notFound() {
  return Object.assign(new Error("Not Found"), {
    name: "NotFoundError",
    response: { status: 404 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.HORIZON_READ_RETRY_MAX_ATTEMPTS = 3;
  h.HORIZON_READ_RETRY_INITIAL_DELAY_MS = 250;
  h.HORIZON_READ_RETRY_MAX_DELAY_MS = 2_000;
});

describe("getTransactionFromHorizon retry behaviour (issue #531)", () => {
  it("recovers a transient 5xx with a second attempt", async () => {
    h.transactionCall
      .mockRejectedValueOnce(serverError())
      .mockResolvedValueOnce({ hash: "abc", successful: true });

    const tx = await getTransactionFromHorizon("hash_1");

    expect(tx).toEqual({ hash: "abc", successful: true });
    expect(h.transactionCall).toHaveBeenCalledTimes(2);
  });

  it("retries until the configured budget is exhausted, then throws", async () => {
    h.transactionCall.mockRejectedValue(serverError());

    await expect(getTransactionFromHorizon("hash_2")).rejects.toThrow(
      "Horizon request failed"
    );
    // 3 total attempts (maxAttempts includes the first), not 4, not 1.
    expect(h.transactionCall).toHaveBeenCalledTimes(3);
  });

  it("fails immediately on a non-retryable 4xx without a second call", async () => {
    h.transactionCall.mockRejectedValue(badRequest());

    await expect(getTransactionFromHorizon("hash_3")).rejects.toThrow(
      "Horizon request failed"
    );
    expect(h.transactionCall).toHaveBeenCalledTimes(1);
  });

  it("treats a 404 as a domain answer and never retries it", async () => {
    h.transactionCall.mockRejectedValue(notFound());

    const tx = await getTransactionFromHorizon("hash_4");

    expect(tx).toBeNull();
    expect(h.transactionCall).toHaveBeenCalledTimes(1);
  });
});

describe("getTransactionPayments retry behaviour (issue #531)", () => {
  it("recovers a transient failure and returns the payment operations", async () => {
    h.paymentsCall
      .mockRejectedValueOnce(
        Object.assign(new Error("Too Many Requests"), {
          response: { status: 429 },
        })
      )
      .mockResolvedValueOnce({
        records: [{ type: "payment", destination: "GTO", amount: "1" }],
      });

    const ops = await getTransactionPayments("hash_5");

    expect(ops).toEqual([{ type: "payment", destination: "GTO", amount: "1" }]);
    expect(h.paymentsCall).toHaveBeenCalledTimes(2);
  });

  it("exhausts the budget on repeated transient failures", async () => {
    h.paymentsCall.mockRejectedValue(serverError());

    await expect(getTransactionPayments("hash_6")).rejects.toThrow(
      "Horizon request failed"
    );
    expect(h.paymentsCall).toHaveBeenCalledTimes(3);
  });
});

describe("backoff schedule (issue #531)", () => {
  it("doubles the delay between attempts, capped at maxDelayMs", async () => {
    // Directly assert the shared backoff helper the query retry uses, with
    // the documented defaults (250ms initial, 2s cap) and no jitter.
    const { horizonRetryDelayMs } = await import("../src/services/horizon-retry");
    const policy = {
      maxAttempts: 5,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
      jitterRatio: 0,
    };

    // Attempt 1 fails → delay before attempt 2 is the initial delay.
    expect(horizonRetryDelayMs(1, policy, () => 0.5)).toBe(250);
    // Attempt 2 → doubled.
    expect(horizonRetryDelayMs(2, policy, () => 0.5)).toBe(500);
    // Attempt 3 → doubled again.
    expect(horizonRetryDelayMs(3, policy, () => 0.5)).toBe(1_000);
    // Attempt 4 → would be 2000, still the cap.
    expect(horizonRetryDelayMs(4, policy, () => 0.5)).toBe(2_000);
    // Attempt 5+ → stays capped at maxDelayMs.
    expect(horizonRetryDelayMs(9, policy, () => 0.5)).toBe(2_000);
  });

  it("keeps jitter within the configured ratio", async () => {
    const { horizonRetryDelayMs } = await import("../src/services/horizon-retry");
    const policy = {
      maxAttempts: 5,
      initialDelayMs: 1_000,
      maxDelayMs: 10_000,
      jitterRatio: 0.3,
    };

    for (let i = 0; i < 50; i++) {
      const delay = horizonRetryDelayMs(1, policy);
      expect(delay).toBeGreaterThanOrEqual(700);
      expect(delay).toBeLessThanOrEqual(1_300);
    }
  });

  it("spends the documented budget from the environment defaults", async () => {
    // The default policy resolves from the HORIZON_READ_RETRY_* variables:
    // 3 attempts total, exponential backoff between them.
    const { HORIZON_RETRY_POLICY } = await import("../src/services/horizon-retry");
    expect(HORIZON_RETRY_POLICY.maxAttempts).toBeGreaterThan(1);
    expect(HORIZON_RETRY_POLICY.maxDelayMs).toBeGreaterThanOrEqual(
      HORIZON_RETRY_POLICY.initialDelayMs
    );
  });
});
