import { describe, it, expect, vi } from "vitest";
import {
  withRetry,
  backoffDelayMs,
  classifyUpstreamFailure,
  isRetryableFailure,
  defaultReadPolicy,
  toUpstreamError,
  upstreamCauseOf,
  logRetryAttempt,
  type RetryPolicy,
} from "../src/services/retry";
import { TimeoutError, TransportError } from "../src/services/timeout";

/**
 * A policy with no real delay, so tests exercise the retry decisions rather
 * than the clock. `sleep` is injected separately and asserted on where the
 * backoff itself is the subject.
 */
const testPolicy: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 1000,
  jitterRatio: 0.25,
};

/** Collects the delays a run would have slept for, without sleeping. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms);
    },
  };
}

/** An error carrying an HTTP status, as the anchor and Horizon adapters raise. */
function httpError(status: number): Error & { status: number; statusCode: number; code: string } {
  return Object.assign(new Error(`HTTP ${status}`), {
    status,
    statusCode: status,
    code: "UPSTREAM_ERROR",
  });
}

describe("classifyUpstreamFailure", () => {
  it("classifies timeouts and transport failures", () => {
    expect(classifyUpstreamFailure(new TimeoutError("op", 1000))).toBe("timeout");
    expect(classifyUpstreamFailure(new TransportError("op", new Error("ECONNRESET")))).toBe(
      "transport"
    );
  });

  it("classifies HTTP statuses", () => {
    expect(classifyUpstreamFailure(httpError(503))).toBe("server_error");
    expect(classifyUpstreamFailure(httpError(500))).toBe("server_error");
    expect(classifyUpstreamFailure(httpError(429))).toBe("rate_limited");
    expect(classifyUpstreamFailure(httpError(400))).toBe("client_error");
    expect(classifyUpstreamFailure(httpError(401))).toBe("client_error");
    expect(classifyUpstreamFailure(httpError(404))).toBe("client_error");
  });

  it("reads a status off a nested response object", () => {
    expect(classifyUpstreamFailure({ response: { status: 502 } })).toBe("server_error");
  });

  it("returns unknown for an unclassifiable error", () => {
    expect(classifyUpstreamFailure(new Error("who knows"))).toBe("unknown");
    expect(classifyUpstreamFailure(null)).toBe("unknown");
  });
});

describe("isRetryableFailure", () => {
  it("retries only failures a later attempt could survive", () => {
    expect(isRetryableFailure("timeout")).toBe(true);
    expect(isRetryableFailure("transport")).toBe(true);
    expect(isRetryableFailure("server_error")).toBe(true);
  });

  it("does not retry client errors, rate limits, or unclassified errors", () => {
    expect(isRetryableFailure("client_error")).toBe(false);
    expect(isRetryableFailure("rate_limited")).toBe(false);
    expect(isRetryableFailure("unknown")).toBe(false);
  });
});

describe("backoffDelayMs", () => {
  it("has no delay before the first attempt", () => {
    expect(backoffDelayMs(1, testPolicy, () => 0)).toBe(0);
  });

  it("grows exponentially from the initial delay", () => {
    const noJitter = () => 0;
    expect(backoffDelayMs(2, testPolicy, noJitter)).toBe(100);
    expect(backoffDelayMs(3, testPolicy, noJitter)).toBe(200);
    expect(backoffDelayMs(4, testPolicy, noJitter)).toBe(400);
  });

  it("caps the delay at maxDelayMs", () => {
    // Attempt 10 would be 100 * 2^8 = 25_600ms without the cap.
    expect(backoffDelayMs(10, testPolicy, () => 0)).toBe(testPolicy.maxDelayMs);
  });

  it("subtracts jitter within the configured ratio", () => {
    // Full jitter draw removes the whole 25% band from the 100ms base delay.
    expect(backoffDelayMs(2, testPolicy, () => 1)).toBe(75);
    expect(backoffDelayMs(2, testPolicy, () => 0.5)).toBe(88);
  });

  it("never returns a negative delay", () => {
    const aggressive: RetryPolicy = { ...testPolicy, jitterRatio: 1 };
    expect(backoffDelayMs(2, aggressive, () => 1)).toBe(0);
  });
});

describe("withRetry", () => {
  it("returns the value of a successful first attempt without sleeping", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(
      { operation: "Test.read", timeoutMs: 1000, policy: testPolicy, sleep },
      fn
    );

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("retries a transient failure and returns the eventual success", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TransportError("Test.read", new Error("ECONNRESET")))
      .mockResolvedValue("recovered");

    const result = await withRetry(
      {
        operation: "Test.read",
        timeoutMs: 1000,
        policy: testPolicy,
        sleep,
        random: () => 0,
      },
      fn
    );

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([100]);
  });

  it("retries timeouts up to the attempt bound, then fails", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new TimeoutError("Test.read", 1000));

    await expect(
      withRetry(
        {
          operation: "Test.read",
          timeoutMs: 1000,
          policy: testPolicy,
          sleep,
          random: () => 0,
        },
        fn
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(testPolicy.maxAttempts);
    // One backoff between each pair of attempts, none after the last.
    expect(delays).toEqual([100, 200]);
  });

  it("retries 5xx responses", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(httpError(503));

    await expect(
      withRetry(
        { operation: "Test.read", timeoutMs: 1000, policy: testPolicy, sleep, random: () => 0 },
        fn
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(testPolicy.maxAttempts);
  });

  it("does not retry a 4xx validation or authentication failure", async () => {
    const { delays, sleep } = recordingSleep();

    for (const status of [400, 401, 403, 404]) {
      const fn = vi.fn().mockRejectedValue(httpError(status));

      await expect(
        withRetry(
          { operation: "Test.read", timeoutMs: 1000, policy: testPolicy, sleep },
          fn
        )
      ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

      expect(fn).toHaveBeenCalledTimes(1);
    }

    expect(delays).toEqual([]);
  });

  it("does not retry into a rate limit", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(httpError(429));

    await expect(
      withRetry({ operation: "Test.read", timeoutMs: 1000, policy: testPolicy, sleep }, fn)
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("treats an unrecognised throw from an attempt as a transport failure", async () => {
    // `withTimeout` normalizes anything it cannot identify into a
    // TransportError, so an unrecognised throw out of a network call is
    // retried as a transport blip rather than surfacing unclassified.
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new Error("unrecognised"));

    await expect(
      withRetry(
        { operation: "Test.read", timeoutMs: 1000, policy: testPolicy, sleep, random: () => 0 },
        fn
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(testPolicy.maxAttempts);
  });

  it("does not retry an unclassifiable failure surfaced as an application error", async () => {
    // An error carrying `statusCode`/`code` passes through withTimeout intact.
    // With a status outside the retryable bands it is a permanent answer.
    const { delays, sleep } = recordingSleep();
    const fn = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("teapot"), { statusCode: 418, status: 418, code: "UPSTREAM_ERROR" })
      );

    await expect(
      withRetry({ operation: "Test.read", timeoutMs: 1000, policy: testPolicy, sleep }, fn)
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("propagates an expected error without retrying or remapping it", async () => {
    const { delays, sleep } = recordingSleep();
    const notFound = httpError(404);
    const fn = vi.fn().mockRejectedValue(notFound);

    await expect(
      withRetry(
        {
          operation: "Test.read",
          timeoutMs: 1000,
          policy: testPolicy,
          sleep,
          isExpected: (err) => (err as { status?: number })?.status === 404,
        },
        fn
      )
    ).rejects.toBe(notFound);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  it("emits structured attempt metadata for every failed attempt", async () => {
    const { sleep } = recordingSleep();
    const entries: unknown[] = [];
    const fn = vi.fn().mockRejectedValue(new TimeoutError("Test.read", 1000));

    await expect(
      withRetry(
        {
          operation: "Test.read",
          timeoutMs: 1000,
          policy: testPolicy,
          sleep,
          random: () => 0,
          onAttemptFailed: (entry) => entries.push(entry),
        },
        fn
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(entries).toEqual([
      { operation: "Test.read", attempt: 1, kind: "timeout", delayMs: 100 },
      { operation: "Test.read", attempt: 2, kind: "timeout", delayMs: 200 },
      // The final attempt reports no pending delay — there is nothing after it.
      { operation: "Test.read", attempt: 3, kind: "timeout", delayMs: 0 },
    ]);
  });

  it("makes exactly one attempt when retrying is disabled", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn().mockRejectedValue(new TimeoutError("Test.read", 1000));

    await expect(
      withRetry(
        {
          operation: "Test.read",
          timeoutMs: 1000,
          policy: { ...testPolicy, maxAttempts: 1 },
          sleep,
        },
        fn
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("bounds a hung upstream with a per-attempt timeout", async () => {
    const { sleep } = recordingSleep();
    // Never settles: only the timeout can end this attempt.
    const fn = vi.fn().mockImplementation(() => new Promise(() => {}));

    await expect(
      withRetry(
        {
          operation: "Test.read",
          timeoutMs: 10,
          policy: { ...testPolicy, maxAttempts: 2 },
          sleep,
          random: () => 0,
        },
        fn
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("passes the attempt number and an abort signal to the operation", async () => {
    const { sleep } = recordingSleep();
    const seen: Array<{ attempt: number; aborted: boolean }> = [];

    await expect(
      withRetry(
        {
          operation: "Test.read",
          timeoutMs: 1000,
          policy: { ...testPolicy, maxAttempts: 2 },
          sleep,
          random: () => 0,
        },
        async (signal, attempt) => {
          seen.push({ attempt, aborted: signal.aborted });
          throw new TimeoutError("Test.read", 1000);
        }
      )
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(seen).toEqual([
      { attempt: 1, aborted: false },
      { attempt: 2, aborted: false },
    ]);
  });
});

describe("toUpstreamError", () => {
  it("maps an exhausted timeout to a stable deadline message", () => {
    const err = toUpstreamError(new TimeoutError("Horizon.loadAccount", 1000), "Horizon.loadAccount", 3);
    expect(err.code).toBe("UPSTREAM_ERROR");
    expect(err.message).toContain("Horizon.loadAccount");
    expect(err.message).toContain("3 attempt(s)");
  });

  it("names a rate limit distinctly", () => {
    const err = toUpstreamError(httpError(429), "Anchor.getToml", 3);
    expect(err.message).toContain("rate limited");
  });

  it("does not leak the upstream response into the message", () => {
    const raw = Object.assign(new Error("GAXXXX insufficient balance, secret=hunter2"), {
      status: 500,
      response: { data: { extras: { result_codes: ["tx_failed"] } } },
    });
    const err = toUpstreamError(raw, "Horizon.loadAccount", 3);

    expect(err.message).not.toContain("hunter2");
    expect(err.message).not.toContain("GAXXXX");
    expect(err.message).not.toContain("tx_failed");
  });

  it("preserves the originating error out of band", () => {
    const raw = httpError(503);
    const err = toUpstreamError(raw, "Anchor.pollTransaction", 3);

    expect(upstreamCauseOf(err)).toBe(raw);
    // Out of band: serializing the error must not carry the cause with it.
    expect(Object.keys(err)).not.toContain("upstreamCause");
    expect(JSON.stringify(err)).not.toContain("upstreamCause");
  });
});

describe("upstreamCauseOf", () => {
  it("returns undefined for values that carry no cause", () => {
    expect(upstreamCauseOf(new Error("plain"))).toBeUndefined();
    expect(upstreamCauseOf(null)).toBeUndefined();
    expect(upstreamCauseOf("string")).toBeUndefined();
  });
});

describe("logRetryAttempt", () => {
  it("logs a consistent field shape for every integration", () => {
    const warn = vi.fn();
    logRetryAttempt(
      { warn },
      { operation: "Anchor.getToml", attempt: 2, kind: "server_error", delayMs: 250 }
    );

    expect(warn).toHaveBeenCalledWith(
      {
        operation: "Anchor.getToml",
        attempt: 2,
        failureKind: "server_error",
        retryInMs: 250,
      },
      "upstream call failed"
    );
  });
});

describe("defaultReadPolicy", () => {
  it("is conservative enough to bound a request without stalling it", () => {
    const policy = defaultReadPolicy();
    expect(policy.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(policy.maxAttempts).toBeLessThanOrEqual(5);
    expect(policy.initialDelayMs).toBeGreaterThan(0);
    expect(policy.maxDelayMs).toBeGreaterThanOrEqual(policy.initialDelayMs);
    expect(policy.jitterRatio).toBeGreaterThanOrEqual(0);
    expect(policy.jitterRatio).toBeLessThanOrEqual(1);
  });
});
