import { describe, it, expect } from "vitest";
import {
  ANCHOR_RETRY_POLICY,
  classifyJobFailure,
  retryDelayMs,
  safeFailureMessage,
  SETTLEMENT_RETRY_POLICY,
} from "../src/services/job-retry";
import { config } from "../src/config";
import { AppError } from "../src/errors";
import { TimeoutError, TransportError } from "../src/services/timeout";

describe("classifyJobFailure", () => {
  it("treats rate limiting and provider outages as transient", () => {
    expect(classifyJobFailure(new AppError(429, "RATE_LIMITED", "slow down"))).toBe(
      "transient"
    );
    expect(classifyJobFailure(new AppError(502, "UPSTREAM_ERROR", "bad gateway"))).toBe(
      "transient"
    );
    expect(classifyJobFailure(new TransportError("Horizon.submit", "ECONNREFUSED"))).toBe(
      "transient"
    );
    expect(classifyJobFailure(new Error("service unavailable"))).toBe("transient");
  });

  it("treats a lost response as indeterminate, not as a failure to retry blindly", () => {
    expect(classifyJobFailure(new TimeoutError("Horizon.submit", 5000))).toBe(
      "indeterminate"
    );
    expect(classifyJobFailure(new Error("socket hang up"))).toBe("indeterminate");
  });

  it("treats rejected, invalid, and unauthorized requests as permanent", () => {
    expect(
      classifyJobFailure(new AppError(400, "XDR_MISMATCH", "destination does not match"))
    ).toBe("permanent");
    expect(classifyJobFailure(new AppError(401, "UNAUTHORIZED", "nope"))).toBe("permanent");
    expect(classifyJobFailure(new Error("Stellar rejected the transaction"))).toBe(
      "permanent"
    );
    expect(classifyJobFailure(new Error("tx_bad_seq"))).toBe("permanent");
    expect(classifyJobFailure(new Error("op_underfunded"))).toBe("permanent");
  });

  it("defaults an unrecognised failure to indeterminate so the ledger is checked first", () => {
    expect(classifyJobFailure(new Error("something nobody has seen before"))).toBe(
      "indeterminate"
    );
  });
});

describe("retry policy configuration", () => {
  it("builds the settlement policy from environment configuration", () => {
    expect(SETTLEMENT_RETRY_POLICY).toEqual({
      maxAttempts: config.WORKER_SETTLEMENT_MAX_ATTEMPTS,
      initialDelayMs: config.WORKER_SETTLEMENT_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: config.WORKER_SETTLEMENT_RETRY_MAX_DELAY_MS,
      jitterRatio: config.WORKER_SETTLEMENT_RETRY_JITTER_RATIO,
    });
  });

  it("builds the anchor policy from environment configuration", () => {
    expect(ANCHOR_RETRY_POLICY).toEqual({
      maxAttempts: config.WORKER_ANCHOR_MAX_ATTEMPTS,
      initialDelayMs: config.WORKER_ANCHOR_RETRY_INITIAL_DELAY_MS,
      maxDelayMs: config.WORKER_ANCHOR_RETRY_MAX_DELAY_MS,
      jitterRatio: config.WORKER_ANCHOR_RETRY_JITTER_RATIO,
    });
  });

  it("defaults to three bounded settlement attempts", () => {
    expect(SETTLEMENT_RETRY_POLICY.maxAttempts).toBe(3);
    expect(SETTLEMENT_RETRY_POLICY.maxDelayMs).toBe(30_000);
  });
});

describe("retryDelayMs", () => {
  it("backs off exponentially and stays within the policy's cap", () => {
    const noJitter = () => 0.5; // jitter term resolves to zero
    expect(retryDelayMs(1, SETTLEMENT_RETRY_POLICY, noJitter)).toBe(
      SETTLEMENT_RETRY_POLICY.initialDelayMs
    );
    expect(retryDelayMs(2, SETTLEMENT_RETRY_POLICY, noJitter)).toBe(
      SETTLEMENT_RETRY_POLICY.initialDelayMs * 2
    );
    expect(retryDelayMs(3, SETTLEMENT_RETRY_POLICY, noJitter)).toBe(
      SETTLEMENT_RETRY_POLICY.initialDelayMs * 4
    );
    expect(retryDelayMs(50, SETTLEMENT_RETRY_POLICY, noJitter)).toBe(
      SETTLEMENT_RETRY_POLICY.maxDelayMs
    );
  });

  it("jitters within the configured ratio so workers do not resubmit in lockstep", () => {
    const base = SETTLEMENT_RETRY_POLICY.initialDelayMs;
    const spread = base * SETTLEMENT_RETRY_POLICY.jitterRatio;

    expect(retryDelayMs(1, SETTLEMENT_RETRY_POLICY, () => 0)).toBe(base - spread);
    expect(retryDelayMs(1, SETTLEMENT_RETRY_POLICY, () => 1)).toBe(base + spread);
  });

  it("returns no delay for a nonsensical attempt number", () => {
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(Number.NaN)).toBe(0);
  });
});

describe("safeFailureMessage", () => {
  it("redacts credentials and transaction payloads", () => {
    const message = safeFailureMessage(
      new Error(
        "submit failed: bearer eyJhbGciOi.abc123 secret=hunter2 xdr=AAAAAgAAAABlongenvelope"
      )
    );

    expect(message).not.toMatch(/eyJhbGciOi/);
    expect(message).not.toMatch(/hunter2/);
    expect(message).not.toMatch(/AAAAAgAAAAB/);
    expect(message).toContain("[redacted]");
  });

  it("bounds the recorded reason", () => {
    expect(safeFailureMessage(new Error("x".repeat(1000)), 100)).toHaveLength(100);
  });
});
