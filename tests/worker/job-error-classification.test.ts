import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return { logger };
});

vi.mock("pino", () => ({ default: vi.fn(() => h.logger) }));

import { AppError } from "../../src/errors";
import { asJobError, JobError } from "../../src/services/job-retry";
import { executeWorkerJobWithRetry } from "../../src/worker/job-retry-handler";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("worker job error classification (#1020)", () => {
  it("marks Horizon 5xx failures retryable and permanent payload errors non-retryable", () => {
    const horizon = asJobError({ status: 503, message: "Horizon is unavailable" });
    expect(horizon).toBeInstanceOf(JobError);
    expect(horizon.category).toBe("transient");
    expect(horizon.retryable).toBe(true);

    const payload = asJobError(new AppError(400, "INVALID_INTENT", "Invalid settlement intent"));
    expect(payload.category).toBe("permanent");
    expect(payload.retryable).toBe(false);

    const timeout = asJobError(new Error("network timeout"));
    expect(timeout.category).toBe("indeterminate");
    expect(timeout.retryable).toBe(true);
  });

  it("retries retryable failures with scheduled backoff and logs job lifecycle", async () => {
    vi.useFakeTimers();

    const task = vi.fn(async (attempt: number) => {
      if (attempt < 3) throw { status: 503, message: "Horizon is unavailable" };
      return "settled";
    });

    const promise = executeWorkerJobWithRetry(task, {
      taskName: "submit_settlement",
      jobType: "settlement",
      jobId: "settlement-42",
      policy: {
        maxAttempts: 3,
        initialDelayMs: 100,
        maxDelayMs: 100,
        jitterRatio: 0,
      },
    });

    await flush();
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.attempts).toBe(3);
    expect(task).toHaveBeenCalledTimes(3);
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "settlement",
        jobId: "settlement-42",
        outcome: "started",
      }),
      "settlement started"
    );
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "settlement",
        jobId: "settlement-42",
        outcome: "retry_scheduled",
        retryable: true,
        delayMs: 100,
      }),
      "settlement retry_scheduled"
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "settlement",
        jobId: "settlement-42",
        outcome: "completed",
      }),
      "settlement completed"
    );
  });

  it("fails non-retryable failures immediately without scheduling a retry", async () => {
    const task = vi.fn(async () => {
      throw new AppError(400, "INVALID_INTENT", "Invalid settlement intent payload");
    });
    const sleep = vi.fn(async () => {});

    const result = await executeWorkerJobWithRetry(task, {
      taskName: "submit_settlement",
      jobType: "settlement",
      jobId: "settlement-7",
      sleep,
    });

    expect(result.success).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(result.attempts).toBe(1);
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "settlement",
        jobId: "settlement-7",
        outcome: "dead_letter",
        retryable: false,
        category: "permanent",
        reason: "Invalid settlement intent payload",
      }),
      "settlement error"
    );
  });
});
