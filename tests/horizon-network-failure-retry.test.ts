/**
 * Issue #688 — network-failure retry behaviour for Stellar Horizon polling.
 *
 * The worker's Horizon reads are wrapped by `withHorizonRetry`
 * (src/services/horizon-retry.ts), which classifies each failure before
 * deciding to try again:
 *
 *   - a dropped connection (`TransportError`) is transient → retried with
 *     exponential backoff up to the configured attempt budget;
 *   - a timeout (`TimeoutError`) is indeterminate → retried, while the caller
 *     reconciles the ledger before acting on the result;
 *   - a rejected envelope (`tx_*` result code) is permanent → fails on the
 *     first attempt.
 *
 * These tests drive the wrapper directly with the same typed errors the
 * Stellar SDK path produces, and assert both the attempt count and the exact
 * error that propagates when the budget is exhausted — the acceptance-
 * criteria contract "retry attempts and final error propagation".
 */
import { describe, it, expect, vi } from "vitest";
import {
  HORIZON_RETRY_POLICY,
  isRetrySuccess,
  withHorizonRetry,
} from "../src/services/horizon-retry";
import { logRetryAttempt } from "../src/services/retry";
import { TimeoutError, TransportError } from "../src/services/timeout";

/** Never wait on real time. */
const noSleep = async (): Promise<void> => undefined;

describe("Horizon polling under network failures (#688)", () => {
  it("retries a dropped connection with backoff and returns the first success", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("Horizon.getTransaction", new Error("socket hang up")))
      .mockRejectedValueOnce(new TransportError("Horizon.getTransaction", new Error("ECONNRESET")))
      .mockResolvedValueOnce({ hash: "abc", successful: true });

    const attempts: number[] = [];
    const delays: number[] = [];

    const outcome = await withHorizonRetry(fn, {
      delay: noSleep,
      onRetry: (_error, attempt, delayMs) => {
        attempts.push(attempt);
        delays.push(delayMs);
      },
    });

    expect(fn).toHaveBeenCalledTimes(3);
    expect(attempts).toEqual([1, 2]);
    // Exponential backoff doubles the delay between retries.
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(isRetrySuccess(outcome)).toBe(true);
    if (isRetrySuccess(outcome)) {
      expect(outcome.value).toEqual({ hash: "abc", successful: true });
    }
  });

  it("treats a Stellar server timeout as indeterminate and still retries it", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TimeoutError("Horizon.getTransaction", 2_000))
      .mockResolvedValueOnce(null);

    const outcome = await withHorizonRetry(fn, { delay: noSleep });

    expect(fn).toHaveBeenCalledTimes(2);
    expect(isRetrySuccess(outcome)).toBe(true);
    if (isRetrySuccess(outcome)) expect(outcome.value).toBeNull();
  });

  it("propagates the final network error once the attempt budget is exhausted", async () => {
    const lastError = new TransportError(
      "Horizon.getTransaction",
      new Error("connection refused")
    );
    const fn = vi.fn().mockRejectedValue(lastError);

    const outcome = await withHorizonRetry(fn, { delay: noSleep });

    expect(fn).toHaveBeenCalledTimes(HORIZON_RETRY_POLICY.maxAttempts);
    expect(isRetrySuccess(outcome)).toBe(false);
    if (!isRetrySuccess(outcome)) {
      expect(outcome.attempts).toBe(HORIZON_RETRY_POLICY.maxAttempts);
      // The exact failure is preserved for the caller's logs and decision.
      expect(outcome.lastError).toBe(lastError);
    }
  });

  it("honours a configurable maximum attempt count", async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError("Horizon.loadAccount", new Error("ENOTFOUND")));

    const outcome = await withHorizonRetry(fn, {
      policy: { ...HORIZON_RETRY_POLICY, maxAttempts: 5 },
      delay: noSleep,
    });

    expect(fn).toHaveBeenCalledTimes(5);
    if (!isRetrySuccess(outcome)) expect(outcome.attempts).toBe(5);
  });

  it("does not retry a permanent Stellar rejection", async () => {
    const rejection = Object.assign(new Error("tx_bad_seq"), {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction_result_code: "tx_bad_seq" } } },
      },
    });
    const fn = vi.fn().mockRejectedValue(rejection);

    const outcome = await withHorizonRetry(fn, { delay: noSleep });

    expect(fn).toHaveBeenCalledTimes(1);
    if (!isRetrySuccess(outcome)) {
      expect(outcome.attempts).toBe(1);
      expect(outcome.lastError).toBe(rejection);
    }
  });

  it("logs each retry with structured Pino fields", () => {
    const warn = vi.fn();
    logRetryAttempt(
      { warn },
      {
        operation: "Horizon.getTransaction",
        attempt: 2,
        kind: "transport",
        delayMs: 640,
      }
    );

    expect(warn).toHaveBeenCalledWith(
      {
        operation: "Horizon.getTransaction",
        attempt: 2,
        failureKind: "transport",
        retryInMs: 640,
      },
      "upstream call failed"
    );
  });
});
