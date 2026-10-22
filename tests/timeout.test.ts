import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  withTimeout,
  fetchWithTimeout,
  TimeoutError,
  TransportError,
  classifyExternalError,
  toAppError,
  retryRead,
  readRetryDelayMs,
} from "../src/services/timeout";
import { Errors } from "../src/errors";

describe("TimeoutError", () => {
  it("creates a descriptive error message", () => {
    const err = new TimeoutError("testOp", 5000);
    expect(err.message).toContain("testOp");
    expect(err.message).toContain("5000");
    expect(err.name).toBe("TimeoutError");
    expect(err.operation).toBe("testOp");
    expect(err.timeoutMs).toBe(5000);
  });
});

describe("TransportError", () => {
  it("wraps an underlying cause", () => {
    const cause = new Error("ECONNREFUSED");
    const err = new TransportError("testOp", cause);
    expect(err.message).toContain("testOp");
    expect(err.message).toContain("ECONNREFUSED");
    expect(err.name).toBe("TransportError");
    expect(err.cause).toBe(cause);
  });

  it("handles non-Error causes", () => {
    const err = new TransportError("testOp", "something went wrong");
    expect(err.message).toContain("something went wrong");
  });
});

describe("withTimeout", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("resolves when the operation completes before the timeout", async () => {
    await expect(withTimeout("test", 1000, async () => "done")).resolves.toBe("done");
  });

  it("rejects with TimeoutError when the operation exceeds the timeout", async () => {
    await expect(
      withTimeout("test", 50, async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return "done";
      })
    ).rejects.toThrow(TimeoutError);
  }, 2000);

  it("rejects with TransportError on non-timeout errors", async () => {
    await expect(
      withTimeout("test", 1000, async () => {
        throw new Error("ECONNREFUSED");
      })
    ).rejects.toThrow(TransportError);
  });

  it("re-throws AppError instances as-is", async () => {
    const appError = Errors.badRequest("xdr_mismatch", "bad XDR");
    await expect(
      withTimeout("test", 1000, async () => {
        throw appError;
      })
    ).rejects.toThrow(appError);
  });

  it("re-throws TimeoutError from the operation", async () => {
    const timeoutError = new TimeoutError("inner", 100);
    await expect(
      withTimeout("test", 1000, async () => {
        throw timeoutError;
      })
    ).rejects.toThrow(TimeoutError);
  });

  it("re-throws TransportError from the operation", async () => {
    const transportError = new TransportError("inner", "fail");
    await expect(
      withTimeout("test", 1000, async () => {
        throw transportError;
      })
    ).rejects.toThrow(TransportError);
  });

  it("clears the timer on success", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout("test", 1000, async () => "done");
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("clears the timer on error", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await expect(
      withTimeout("test", 1000, async () => {
        throw new Error("fail");
      })
    ).rejects.toThrow(TransportError);
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("classifyExternalError", () => {
  it("classifies TimeoutError as timeout", () => {
    expect(classifyExternalError(new TimeoutError("op", 100))).toBe("timeout");
  });

  it("classifies TransportError as transport", () => {
    expect(classifyExternalError(new TransportError("op", "fail"))).toBe("transport");
  });

  it("classifies UPSTREAM_ERROR AppError as upstream", () => {
    expect(classifyExternalError(Errors.upstream("fail"))).toBe("upstream");
  });

  it("classifies other errors as unknown", () => {
    expect(classifyExternalError(new Error("generic"))).toBe("unknown");
    expect(classifyExternalError("string error")).toBe("unknown");
  });
});

describe("readRetryDelayMs", () => {
  const policy = { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 800 };

  it("backs off exponentially and never exceeds the cap", () => {
    const noJitter = () => 0.5;
    expect(readRetryDelayMs(1, policy, noJitter)).toBe(100);
    expect(readRetryDelayMs(2, policy, noJitter)).toBe(200);
    expect(readRetryDelayMs(3, policy, noJitter)).toBe(400);
    expect(readRetryDelayMs(4, policy, noJitter)).toBe(800);
    expect(readRetryDelayMs(50, policy, noJitter)).toBe(800);
  });

  it("jitters within a small bound so processes do not retry in lockstep", () => {
    const base = policy.initialDelayMs;
    const spread = base * 0.1;
    expect(readRetryDelayMs(1, policy, () => 0)).toBe(base - spread);
    expect(readRetryDelayMs(1, policy, () => 1)).toBe(base + spread);
  });

  it("returns no delay for a nonsensical attempt number", () => {
    expect(readRetryDelayMs(0, policy)).toBe(0);
    expect(readRetryDelayMs(Number.NaN, policy)).toBe(0);
  });
});

describe("retryRead", () => {
  const policy = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 };
  const sleep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    sleep.mockClear();
  });

  it("returns the first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(retryRead("op", policy, fn, { sleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient failures and succeeds on a later attempt", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("op", "ECONNRESET"))
      .mockRejectedValueOnce(new TimeoutError("op", 100))
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    await expect(
      retryRead("op", policy, fn, { sleep, onRetry })
    ).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    // Only after the failing attempts, never on success.
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, maxAttempts: 3 });
    expect(onRetry.mock.calls[1][0]).toMatchObject({ attempt: 2, maxAttempts: 3 });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rejects a 5xx upstream error as transient after the budget is exhausted", async () => {
    const upstream = Errors.upstream("Horizon is having a bad day");
    const fn = vi.fn().mockRejectedValue(upstream);

    await expect(retryRead("op", policy, fn, { sleep })).rejects.toBe(upstream);
    expect(fn).toHaveBeenCalledTimes(policy.maxAttempts);
  });

  it("re-throws the original error category after exhausting retries", async () => {
    const timeout = new TimeoutError("op", 100);
    const fn = vi.fn().mockRejectedValue(timeout);

    await expect(retryRead("op", policy, fn, { sleep })).rejects.toBe(timeout);
    expect(fn).toHaveBeenCalledTimes(policy.maxAttempts);
  });

  it("fails immediately on a non-retryable error without extra calls", async () => {
    const badRequest = Errors.badRequest("xdr_malformed", "nope");
    const fn = vi.fn().mockRejectedValue(badRequest);

    await expect(retryRead("op", policy, fn, { sleep })).rejects.toBe(badRequest);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("fails immediately on an authentication failure without retrying", async () => {
    const unauthorized = Errors.unauthorized("invalid token");
    const fn = vi.fn().mockRejectedValue(unauthorized);

    await expect(retryRead("op", policy, fn, { sleep })).rejects.toBe(unauthorized);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("toAppError", () => {
  it("passes through AppError instances", () => {
    const original = Errors.upstream("original");
    const result = toAppError(original, "fallback");
    expect(result).toBe(original);
  });

  it("wraps TimeoutError as upstream error", () => {
    const result = toAppError(new TimeoutError("op", 100), "Operation failed");
    expect(result.status).toBe(502);
    expect(result.code).toBe("UPSTREAM_ERROR");
    expect(result.message).toContain("Operation failed");
    expect(result.message).toContain("timed out");
  });

  it("wraps TransportError as upstream error", () => {
    const result = toAppError(new TransportError("op", "ECONNREFUSED"), "Operation failed");
    expect(result.status).toBe(502);
    expect(result.code).toBe("UPSTREAM_ERROR");
    expect(result.message).toContain("ECONNREFUSED");
  });

  it("wraps generic errors as upstream error", () => {
    const result = toAppError(new Error("generic"), "Operation failed");
    expect(result.status).toBe(502);
    expect(result.code).toBe("UPSTREAM_ERROR");
  });
});