/**
 * Issue #536 — the retry decision in src/services/retry.ts.
 *
 * `decideRetry` holds the whole policy: which failures are transient, how long
 * to back off, when a 429 may be retried, and when to stop. These tests pin it
 * without timers or network; `withRetry` is then exercised end-to-end with an
 * injected sleep so the backoff schedule is observable.
 */
import { describe, it, expect, vi } from "vitest";
import {
  backoffDelayMs,
  classifyUpstreamFailure,
  decideRetry,
  retryAfterMs,
  withRetry,
  type RetryPolicy,
} from "../src/services/retry";
import { TimeoutError, TransportError } from "../src/services/timeout";

const policy: RetryPolicy = {
  maxAttempts: 4,
  initialDelayMs: 100,
  maxDelayMs: 1_000,
  jitterRatio: 0.5,
};
const withRateLimit: RetryPolicy = { ...policy, retryRateLimited: true };
const noJitter = () => 0;

/** A Horizon SDK-shaped failure: `response` is the problem body. */
function horizonError(status: number, headers?: Record<string, string>) {
  return Object.assign(new Error(`HTTP ${status}`), {
    response: { status, ...(headers ? { headers } : {}) },
  });
}

describe("decideRetry — transient failures are retried", () => {
  it.each([500, 502, 503, 504, 520, 599])("retries HTTP %i", (status) => {
    expect(decideRetry(horizonError(status), 1, policy, noJitter)).toEqual({
      retry: true,
      delayMs: 100,
    });
  });

  it("retries HTTP 408 as a timeout", () => {
    expect(classifyUpstreamFailure(horizonError(408))).toBe("timeout");
    expect(decideRetry(horizonError(408), 1, policy, noJitter).retry).toBe(true);
  });

  it("retries a per-attempt timeout", () => {
    const err = new TimeoutError("Horizon.loadAccount", 5_000);
    expect(decideRetry(err, 1, policy, noJitter)).toEqual({ retry: true, delayMs: 100 });
  });

  it("retries a network failure with no HTTP status", () => {
    const err = new TransportError("Horizon.loadAccount", new Error("ECONNRESET"));
    expect(decideRetry(err, 1, policy, noJitter).retry).toBe(true);
  });

  it("retries a 503 even when it arrives wrapped in a TransportError", () => {
    const err = new TransportError("Horizon.loadAccount", horizonError(503));
    expect(decideRetry(err, 1, policy, noJitter).retry).toBe(true);
  });
});

describe("decideRetry — permanent failures are not retried", () => {
  it.each([400, 401, 403, 404, 409, 410, 422])("does not retry HTTP %i", (status) => {
    expect(decideRetry(horizonError(status), 1, withRateLimit, noJitter)).toEqual({
      retry: false,
      delayMs: 0,
    });
  });

  it.each([501, 505])("does not retry HTTP %i (describes the request, not an outage)", (status) => {
    expect(decideRetry(horizonError(status), 1, withRateLimit, noJitter).retry).toBe(false);
  });

  it("does not retry a 400 wrapped in a TransportError", () => {
    const err = new TransportError("Horizon.loadAccount", horizonError(400));
    expect(decideRetry(err, 1, policy, noJitter).retry).toBe(false);
  });

  it("does not retry an unclassifiable error (guessing retryable can duplicate work)", () => {
    expect(decideRetry({ weird: true }, 1, policy, noJitter).retry).toBe(false);
  });

  it("stops at the attempt budget", () => {
    expect(decideRetry(horizonError(503), 3, policy, noJitter).retry).toBe(true);
    expect(decideRetry(horizonError(503), 4, policy, noJitter)).toEqual({ retry: false, delayMs: 0 });
    expect(decideRetry(horizonError(503), 1, { ...policy, maxAttempts: 1 }).retry).toBe(false);
  });
});

describe("decideRetry — HTTP 429", () => {
  it("is not retried by default", () => {
    expect(decideRetry(horizonError(429), 1, policy, noJitter).retry).toBe(false);
  });

  it("is retried with exponential backoff when the policy opts in", () => {
    expect(decideRetry(horizonError(429), 1, withRateLimit, noJitter)).toEqual({ retry: true, delayMs: 100 });
    expect(decideRetry(horizonError(429), 2, withRateLimit, noJitter)).toEqual({ retry: true, delayMs: 200 });
    expect(decideRetry(horizonError(429), 3, withRateLimit, noJitter)).toEqual({ retry: true, delayMs: 400 });
  });

  it("waits at least the upstream's Retry-After when it is within the cap", () => {
    const err = horizonError(429, { "retry-after": "1" });
    expect(decideRetry(err, 1, withRateLimit, noJitter)).toEqual({ retry: true, delayMs: 1_000 });
  });

  it("keeps the larger backoff when Retry-After is shorter", () => {
    const err = horizonError(429, { "retry-after": "0" });
    expect(decideRetry(err, 3, withRateLimit, noJitter)).toEqual({ retry: true, delayMs: 400 });
  });

  it("surfaces the 429 instead of sleeping through a Retry-After beyond the cap", () => {
    const err = horizonError(429, { "retry-after": "30" });
    expect(decideRetry(err, 1, withRateLimit, noJitter)).toEqual({ retry: false, delayMs: 0 });
  });

  it("still respects the attempt budget", () => {
    expect(decideRetry(horizonError(429), 4, withRateLimit, noJitter).retry).toBe(false);
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");

  it("parses delta-seconds", () => {
    expect(retryAfterMs(horizonError(429, { "retry-after": "2" }), now)).toBe(2_000);
  });

  it("parses an HTTP-date", () => {
    const err = horizonError(429, { "retry-after": "Sat, 26 Sep 2026 12:00:03 GMT" });
    expect(retryAfterMs(err, now)).toBe(3_000);
  });

  it("clamps an HTTP-date in the past to zero", () => {
    const err = horizonError(429, { "retry-after": "Sat, 26 Sep 2026 11:00:00 GMT" });
    expect(retryAfterMs(err, now)).toBe(0);
  });

  it("falls back to X-RateLimit-Reset seconds", () => {
    expect(retryAfterMs(horizonError(429, { "x-ratelimit-reset": "4" }), now)).toBe(4_000);
  });

  it("reads Headers-like objects with get()", () => {
    const headers = { get: (n: string) => (n === "retry-after" ? "5" : null) };
    const err = Object.assign(new Error("429"), { response: { status: 429, headers } });
    expect(retryAfterMs(err, now)).toBe(5_000);
  });

  it.each([
    ["no headers", horizonError(429)],
    ["garbage value", horizonError(429, { "retry-after": "soon" })],
    ["negative seconds", horizonError(429, { "retry-after": "-5" })],
    ["non-object", "429"],
  ])("returns null for %s", (_label, err) => {
    expect(retryAfterMs(err, now)).toBeNull();
  });
});

describe("backoffDelayMs — exponential, capped, jittered", () => {
  it("doubles from initialDelayMs and caps at maxDelayMs", () => {
    expect([2, 3, 4, 5, 6, 7].map((a) => backoffDelayMs(a, policy, noJitter))).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ]);
  });

  it("removes at most jitterRatio of the delay", () => {
    for (const r of [0, 0.25, 0.5, 0.999]) {
      const d = backoffDelayMs(4, policy, () => r);
      expect(d).toBeGreaterThanOrEqual(400 * (1 - policy.jitterRatio));
      expect(d).toBeLessThanOrEqual(400);
    }
  });

  it("has no delay before the first attempt", () => {
    expect(backoffDelayMs(1, policy)).toBe(0);
  });
});

describe("withRetry — end to end with an injected clock", () => {
  const opts = (p: RetryPolicy, sleep = vi.fn(async () => undefined)) => ({
    operation: "Horizon.test",
    timeoutMs: 1_000,
    policy: p,
    sleep,
    random: noJitter,
  });

  it("recovers after transient failures, sleeping the backoff schedule", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(horizonError(503))
      .mockRejectedValueOnce(new TransportError("Horizon.test", new Error("ECONNRESET")))
      .mockResolvedValue("ok");

    await expect(withRetry(opts(policy, sleep), fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
  });

  it("recovers from a 429 when the policy opts in", async () => {
    const fn = vi.fn().mockRejectedValueOnce(horizonError(429)).mockResolvedValue("ok");
    await expect(withRetry(opts(withRateLimit), fn)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("fails a 429 immediately under the default policy", async () => {
    const fn = vi.fn().mockRejectedValue(horizonError(429));
    await expect(withRetry(opts(policy), fn)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
      category: "rate_limited",
      details: { hint: "Retry the request after a short delay." },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("fails a client error immediately without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn().mockRejectedValue(horizonError(400));
    await expect(withRetry(opts(withRateLimit, sleep), fn)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts with a stable upstream error", async () => {
    const fn = vi.fn().mockRejectedValue(horizonError(503));
    await expect(withRetry(opts(policy), fn)).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: "Horizon.test is unavailable after 4 attempt(s)",
    });
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("reports each failed attempt with its kind and planned delay", async () => {
    const onAttemptFailed = vi.fn();
    const fn = vi.fn().mockRejectedValueOnce(horizonError(429)).mockResolvedValue("ok");
    await withRetry({ ...opts(withRateLimit), onAttemptFailed }, fn);
    expect(onAttemptFailed).toHaveBeenCalledWith({
      operation: "Horizon.test",
      attempt: 1,
      kind: "rate_limited",
      delayMs: 100,
    });
  });
});
