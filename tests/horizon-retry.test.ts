import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyHorizonError,
  horizonRetryDelayMs,
  withHorizonRetry,
  HORIZON_RETRY_POLICY,
  isRetrySuccess,
} from "../src/services/horizon-retry";
import { TimeoutError, TransportError } from "../src/services/timeout";

// ─── error classification ───────────────────────────────────────────────────

describe("classifyHorizonError", () => {
  it("classifies TimeoutError as indeterminate", () => {
    expect(classifyHorizonError(new TimeoutError("submit", 30000))).toBe(
      "indeterminate"
    );
  });

  it("classifies TransportError as transient", () => {
    expect(
      classifyHorizonError(new TransportError("submit", new Error("ECONNREFUSED")))
    ).toBe("transient");
  });

  it("classifies 429 as transient", () => {
    expect(classifyHorizonError({ statusCode: 429 })).toBe("transient");
  });

  it("classifies 500+ as transient", () => {
    expect(classifyHorizonError({ statusCode: 502 })).toBe("transient");
    expect(classifyHorizonError({ statusCode: 503 })).toBe("transient");
  });

  it("classifies 4xx as permanent", () => {
    expect(classifyHorizonError({ statusCode: 400 })).toBe("permanent");
    expect(classifyHorizonError({ statusCode: 404 })).toBe("permanent");
  });

  it("classifies Horizon tx_bad_auth as permanent", () => {
    const error = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction_result_code: "tx_bad_auth",
            },
          },
        },
      },
    };
    expect(classifyHorizonError(error)).toBe("permanent");
  });

  it("classifies Horizon tx_bad_seq as permanent", () => {
    const error = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction_result_code: "tx_bad_seq",
            },
          },
        },
      },
    };
    expect(classifyHorizonError(error)).toBe("permanent");
  });

  it("classifies Horizon op_underfunded as permanent", () => {
    const error = {
      response: {
        data: {
          extras: {
            result_codes: {
              transaction_result_code: "tx_failed",
              operations: ["op_underfunded"],
            },
          },
        },
      },
    };
    expect(classifyHorizonError(error)).toBe("permanent");
  });

  it("classifies Horizon 429 as transient", () => {
    const error = {
      response: {
        data: {
          status: 429,
        },
      },
    };
    expect(classifyHorizonError(error)).toBe("transient");
  });

  it("classifies unknown errors as transient (safe default)", () => {
    expect(classifyHorizonError(new Error("something weird"))).toBe(
      "transient"
    );
  });
});

// ─── backoff calculation ────────────────────────────────────────────────────

describe("horizonRetryDelayMs", () => {
  it("returns 0 for invalid attempts", () => {
    expect(horizonRetryDelayMs(0)).toBe(0);
    expect(horizonRetryDelayMs(-1)).toBe(0);
    expect(horizonRetryDelayMs(NaN)).toBe(0);
  });

  it("doubles the delay each attempt, capped at maxDelayMs", () => {
    const policy = {
      maxAttempts: 10,
      initialDelayMs: 1000,
      maxDelayMs: 8000,
      jitterRatio: 0, // no jitter for deterministic test
    };
    expect(horizonRetryDelayMs(1, policy, () => 0.5)).toBe(1000);
    expect(horizonRetryDelayMs(2, policy, () => 0.5)).toBe(2000);
    expect(horizonRetryDelayMs(3, policy, () => 0.5)).toBe(4000);
    expect(horizonRetryDelayMs(4, policy, () => 0.5)).toBe(8000); // capped
    expect(horizonRetryDelayMs(5, policy, () => 0.5)).toBe(8000); // still capped
  });

  it("applies jitter within the configured ratio", () => {
    const policy = {
      maxAttempts: 5,
      initialDelayMs: 1000,
      maxDelayMs: 30000,
      jitterRatio: 0.3,
    };
    // random()=0: jitter = 1000 * 0.3 * (0*2-1) = -300 → max(0, 700) = 700
    expect(horizonRetryDelayMs(1, policy, () => 0)).toBe(700);
    // random()=1: jitter = 1000 * 0.3 * (1*2-1) = +300 → 1300
    expect(horizonRetryDelayMs(1, policy, () => 1)).toBe(1300);
    // random()=0.5: jitter = 1000 * 0.3 * (1-1) = 0 → 1000
    expect(horizonRetryDelayMs(1, policy, () => 0.5)).toBe(1000);
  });
});

// ─── retry wrapper ──────────────────────────────────────────────────────────

describe("withHorizonRetry", () => {
  const policy = {
    maxAttempts: 3,
    initialDelayMs: 100,
    maxDelayMs: 1000,
    jitterRatio: 0,
  };

  const noopDelay = async () => {};

  it("returns the result on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const result = await withHorizonRetry(fn, { policy, delay: noopDelay });
    expect(isRetrySuccess(result)).toBe(true);
    if (isRetrySuccess(result)) expect(result.value).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on transient errors and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("submit", new Error("ECONNREFUSED")))
      .mockResolvedValueOnce("ok");
    const result = await withHorizonRetry(fn, { policy, delay: noopDelay });
    expect(isRetrySuccess(result)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops immediately on permanent errors", async () => {
    const fn = vi.fn().mockRejectedValue({ statusCode: 400 });
    const result = await withHorizonRetry(fn, { policy, delay: noopDelay });
    expect(isRetrySuccess(result)).toBe(false);
    if (!isRetrySuccess(result)) {
      expect(result.attempts).toBe(1);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns exhausted after max attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError("submit", new Error("fail")));
    const result = await withHorizonRetry(fn, { policy, delay: noopDelay });
    expect(isRetrySuccess(result)).toBe(false);
    if (!isRetrySuccess(result)) {
      expect(result.attempts).toBe(3);
    }
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("calls beforeRetry hook between attempts", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("submit", new Error("fail")))
      .mockResolvedValueOnce("ok");
    const beforeRetry = vi.fn(async () => true);
    const result = await withHorizonRetry(fn, {
      policy,
      delay: noopDelay,
      beforeRetry,
    });
    expect(isRetrySuccess(result)).toBe(true);
    expect(beforeRetry).toHaveBeenCalledTimes(1);
    expect(beforeRetry).toHaveBeenCalledWith(
      expect.any(TransportError),
      1
    );
  });

  it("aborts retry when beforeRetry returns false", async () => {
    const fn = vi.fn().mockRejectedValue(new TransportError("submit", new Error("fail")));
    const beforeRetry = vi.fn(async () => false);
    const result = await withHorizonRetry(fn, {
      policy,
      delay: noopDelay,
      beforeRetry,
    });
    expect(isRetrySuccess(result)).toBe(false);
    if (!isRetrySuccess(result)) {
      expect(result.attempts).toBe(1);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not retry when classify returns indeterminate and beforeRetry aborts", async () => {
    const fn = vi.fn().mockRejectedValue(new TimeoutError("submit", 30000));
    const beforeRetry = vi.fn(async () => false); // abort on indeterminate
    const result = await withHorizonRetry(fn, {
      policy,
      delay: noopDelay,
      beforeRetry,
    });
    expect(isRetrySuccess(result)).toBe(false);
    if (!isRetrySuccess(result)) {
      expect(result.attempts).toBe(1);
    }
  });
});

// ─── isRetrySuccess ─────────────────────────────────────────────────────────

describe("isRetrySuccess", () => {
  it("returns true for success outcomes", () => {
    expect(isRetrySuccess({ ok: true as const, value: "x" })).toBe(true);
  });

  it("returns false for exhausted outcomes", () => {
    expect(
      isRetrySuccess({ ok: false as const, lastError: new Error(), attempts: 1 })
    ).toBe(false);
  });
});
