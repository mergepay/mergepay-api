/**
 * Issue #708 — worker health monitoring and cycle-task retries.
 *
 * `runWorkerCycle` used to run every batch task under `Promise.allSettled`, so
 * a task throwing a transient database or Horizon error was silently swallowed
 * and whatever jobs it owed that cycle just waited for the next one. These
 * tests pin the new contract:
 *
 *   1. `withRetry` (src/worker/health.ts) — transient failures are retried
 *      with the same bounded, jittered exponential backoff the per-job
 *      policies use; permanent and indeterminate failures propagate
 *      immediately; an exhausted budget throws the real error.
 *   2. The health registry — cycle outcomes, consecutive-failure tracking,
 *      and the `healthy` flip at the configured threshold.
 *   3. `runWorkerCycle` end to end (mocked boundaries) — a transient task
 *      failure is retried in-cycle, an exhausted task is dead-lettered as a
 *      critical log line without starving its sibling tasks, and every cycle
 *      emits a `worker_health` heartbeat.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  logger: (() => {
    const logger: any = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    logger.child = vi.fn(() => logger);
    return logger;
  })(),
  prisma: {
    settlement: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    anchorSession: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    withdrawal: { findMany: vi.fn(async () => []) },
    invite: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    $disconnect: vi.fn(async () => {}),
  },
  cleanupChallenges: vi.fn(async () => {}),
  processPendingWebhookDeliveries: vi.fn(async () => ({
    attempted: 0,
    delivered: 0,
    failed: 0,
  })),
  expireStaleProposals: vi.fn(async () => ({
    expired: 0,
    olderThan: new Date("2026-01-01T00:00:00.000Z"),
  })),
  reconcileAllTreasuryBalances: vi.fn(async () => ({
    reconciled: 0,
    variances: 0,
    errors: 0,
  })),
  syncPendingTransactionStatuses: vi.fn(async () => ({
    checked: 0,
    updated: 0,
  })),
}));

vi.mock("pino", () => ({ default: vi.fn(() => h.logger) }));
vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/worker/tasks/cleanup-challenges", () => ({
  cleanupChallenges: h.cleanupChallenges,
}));
vi.mock("../../src/services/webhook", () => ({
  processPendingWebhookDeliveries: h.processPendingWebhookDeliveries,
}));
vi.mock("../../src/worker/cleanupProposals", () => ({
  expireStaleProposals: h.expireStaleProposals,
}));
vi.mock("../../src/services/treasuryService", () => ({
  reconcileAllTreasuryBalances: h.reconcileAllTreasuryBalances,
}));
vi.mock("../../src/worker/tasks/tx-status-sync", () => ({
  syncPendingTransactionStatuses: h.syncPendingTransactionStatuses,
}));
vi.mock("../../src/worker/reconciliation", () => ({
  startReconciliation: vi.fn(() => () => {}),
}));
vi.mock("../../src/services/worker-lock", () => ({
  acquireWorkerLease: vi.fn(async () => ({ key: "k", owner: "o" })),
  releaseWorkerLease: vi.fn(async () => {}),
}));

import {
  CYCLE_TASK_RETRY_POLICY,
  getWorkerHealth,
  logHealthCritical,
  logHealthHeartbeat,
  recordCycleFailure,
  recordCycleStart,
  recordCycleSuccess,
  recordTaskDeadLetter,
  recordTaskFailure,
  resetWorkerHealth,
  withRetry,
} from "../../src/worker/health";
import { runWorkerCycle, setDelayFn } from "../../src/worker/index";

beforeEach(() => {
  vi.clearAllMocks();
  resetWorkerHealth();
  // Drive the backoff schedule without real time passing.
  setDelayFn(async () => {});
});

afterEach(() => {
  setDelayFn(async () => {});
});

/** A fast, deterministic policy for retry tests (no jitter). */
const policy = {
  maxAttempts: 3,
  initialDelayMs: 100,
  maxDelayMs: 10_000,
  jitterRatio: 0,
};

describe("withRetry — exponential backoff for transient failures (#708)", () => {
  it("returns the task's value on first success without sleeping", async () => {
    const sleep = vi.fn(async () => {});
    const task = vi.fn(async () => "ok");

    await expect(withRetry(task, { taskName: "t", policy, sleep })).resolves.toBe("ok");
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a transient failure with exponential backoff, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const onRetry = vi.fn();
    const task = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("service unavailable"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("service unavailable"), { status: 503 }))
      .mockResolvedValueOnce("done");

    await expect(withRetry(task, { taskName: "t", policy, sleep, onRetry })).resolves.toBe(
      "done"
    );

    expect(task).toHaveBeenCalledTimes(3);
    // Backoff schedule: initial * 2^(attempt-1) — 100ms, then 200ms.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);
    expect(onRetry.mock.calls.map(([info]) => info.attempt)).toEqual([1, 2]);
    expect(onRetry.mock.calls.map(([info]) => info.delayMs)).toEqual([100, 200]);
  });

  it("propagates a permanent failure immediately without burning the budget", async () => {
    const sleep = vi.fn(async () => {});
    const permanent = Object.assign(new Error("validation failed"), { status: 400 });
    const task = vi.fn(async () => {
      throw permanent;
    });

    await expect(withRetry(task, { taskName: "t", policy, sleep })).rejects.toBe(permanent);
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("propagates an indeterminate failure for the next cycle to re-run", async () => {
    const sleep = vi.fn(async () => {});
    const indeterminate = Object.assign(new Error("upstream timed out"), {
      name: "TimeoutError",
    });
    const task = vi.fn(async () => {
      throw indeterminate;
    });

    await expect(withRetry(task, { taskName: "t", policy, sleep })).rejects.toBe(
      indeterminate
    );
    expect(task).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("throws the real error after the budget is exhausted", async () => {
    const sleep = vi.fn(async () => {});
    const lastError = Object.assign(new Error("still unavailable"), { status: 503 });
    const task = vi.fn(async () => {
      throw lastError;
    });

    await expect(withRetry(task, { taskName: "t", policy, sleep })).rejects.toBe(lastError);
    expect(task).toHaveBeenCalledTimes(policy.maxAttempts);
    expect(sleep).toHaveBeenCalledTimes(policy.maxAttempts - 1);
  });

  it("caps the delay at the policy maximum", async () => {
    const sleep = vi.fn(async () => {});
    const capped = { ...policy, maxAttempts: 5, maxDelayMs: 150 };
    const task = vi.fn(async () => {
      throw Object.assign(new Error("service unavailable"), { status: 503 });
    });

    await expect(withRetry(task, { taskName: "t", policy: capped, sleep })).rejects.toBeDefined();
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 150, 150, 150]);
  });

  it("respects the default cycle-task policy shape from config", () => {
    expect(CYCLE_TASK_RETRY_POLICY.maxAttempts).toBeGreaterThanOrEqual(1);
    expect(CYCLE_TASK_RETRY_POLICY.initialDelayMs).toBeGreaterThan(0);
    expect(CYCLE_TASK_RETRY_POLICY.jitterRatio).toBeGreaterThanOrEqual(0);
  });
});

describe("worker health registry (#708)", () => {
  it("starts healthy with no cycles recorded", () => {
    const health = getWorkerHealth();
    expect(health.healthy).toBe(true);
    expect(health.cyclesCompleted).toBe(0);
    expect(health.cyclesFailed).toBe(0);
    expect(health.lastCycleOutcome).toBe("never_run");
    expect(health.deadLetteredTasks).toEqual([]);
  });

  it("records cycle timing and outcome on success", async () => {
    recordCycleStart();
    await new Promise((r) => setTimeout(r, 5));
    recordCycleSuccess();

    const health = getWorkerHealth();
    expect(health.cyclesCompleted).toBe(1);
    expect(health.lastCycleOutcome).toBe("success");
    expect(health.lastCycleDurationMs).toBeGreaterThanOrEqual(0);
    expect(health.lastCycleCompletedAt).not.toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it("flips unhealthy after the configured number of consecutive failures", () => {
    // WORKER_HEALTH_UNHEALTHY_THRESHOLD defaults to 3.
    recordCycleStart();
    recordCycleFailure("cycle 1");
    recordCycleStart();
    recordCycleFailure("cycle 2");
    expect(getWorkerHealth().healthy).toBe(true);
    expect(getWorkerHealth().consecutiveFailures).toBe(2);

    recordCycleStart();
    recordCycleFailure("cycle 3");
    expect(getWorkerHealth().consecutiveFailures).toBe(3);
    expect(getWorkerHealth().healthy).toBe(false);
  });

  it("a successful cycle resets the consecutive-failure count", () => {
    recordCycleStart();
    recordCycleFailure("cycle 1");
    recordCycleStart();
    recordCycleFailure("cycle 2");
    recordCycleStart();
    recordCycleSuccess();

    const health = getWorkerHealth();
    expect(health.cyclesFailed).toBe(2);
    expect(health.cyclesCompleted).toBe(1);
    expect(health.consecutiveFailures).toBe(0);
    expect(health.healthy).toBe(true);
  });

  it("counts final task failures per task name", () => {
    recordTaskFailure("reconcileAnchors");
    recordTaskFailure("reconcileAnchors");
    recordTaskFailure("expireInvites");

    const health = getWorkerHealth();
    expect(health.taskFailures).toEqual({ reconcileAnchors: 2, expireInvites: 1 });
  });

  it("records dead-lettered tasks newest first, bounded", () => {
    for (let i = 0; i < 60; i += 1) {
      recordTaskDeadLetter(`task_${i}`);
    }
    const health = getWorkerHealth();
    expect(health.deadLetteredTasks).toHaveLength(50);
    expect(health.deadLetteredTasks[0]).toBe("task_59");
  });

  it("returns a snapshot copy — mutating it does not affect the registry", () => {
    recordTaskFailure("t");
    const health = getWorkerHealth();
    health.taskFailures.t = 99;
    health.deadLetteredTasks.push("bogus");

    expect(getWorkerHealth().taskFailures).toEqual({ t: 1 });
    expect(getWorkerHealth().deadLetteredTasks).toEqual([]);
  });

  it("emits a structured heartbeat with the current health snapshot", () => {
    recordCycleStart();
    recordCycleSuccess();
    logHealthHeartbeat(h.logger);

    expect(h.logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = h.logger.info.mock.calls[0];
    expect(fields.jobType).toBe("worker_health");
    expect(fields.outcome).toBe("heartbeat");
    expect(fields.health.cyclesCompleted).toBe(1);
    expect(msg).toBe("worker heartbeat");
  });

  it("emits a critical health log with the failure reason", () => {
    recordCycleStart();
    recordCycleFailure("database unreachable");
    logHealthCritical(h.logger, "consecutive failed cycles");

    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const [fields, msg] = h.logger.error.mock.calls[0];
    expect(fields.jobType).toBe("worker_health");
    expect(fields.outcome).toBe("critical");
    expect(fields.reason).toBe("consecutive failed cycles");
    expect(fields.health.consecutiveFailures).toBe(1);
    expect(msg).toBe("worker health critical");
  });
});

describe("runWorkerCycle — task retries, dead-lettering, and heartbeat (#708)", () => {
  it("completes cleanly and emits a healthy heartbeat", async () => {
    await runWorkerCycle();

    const health = getWorkerHealth();
    expect(health.cyclesCompleted).toBe(1);
    expect(health.lastCycleOutcome).toBe("success");
    expect(health.healthy).toBe(true);
    expect(health.deadLetteredTasks).toEqual([]);

    const heartbeat = h.logger.info.mock.calls.find(
      ([fields]) => fields?.jobType === "worker_health"
    );
    expect(heartbeat).toBeDefined();
  });

  it("retries a task that fails transiently and still completes the cycle", async () => {
    h.cleanupChallenges
      .mockRejectedValueOnce(Object.assign(new Error("db connection refused"), { status: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("db connection refused"), { status: 503 }))
      .mockResolvedValueOnce(undefined);

    await runWorkerCycle();

    expect(h.cleanupChallenges).toHaveBeenCalledTimes(3);
    const health = getWorkerHealth();
    expect(health.cyclesCompleted).toBe(1);
    expect(health.cyclesFailed).toBe(0);
    expect(health.taskFailures.cleanupChallenges).toBe(2);
    expect(health.deadLetteredTasks).toEqual([]);
  });

  it("dead-letters an exhausted task as critical without starving its siblings", async () => {
    h.cleanupChallenges.mockRejectedValue(
      Object.assign(new Error("service unavailable"), { status: 503 })
    );

    await runWorkerCycle();

    // The default policy budget is spent in this one cycle.
    expect(h.cleanupChallenges).toHaveBeenCalledTimes(CYCLE_TASK_RETRY_POLICY.maxAttempts);
    // The critical dead-letter signal is logged, not swallowed.
    const deadLetter = h.logger.error.mock.calls.find(
      ([fields]) => fields?.outcome === "dead_letter"
    );
    expect(deadLetter).toBeDefined();
    expect(deadLetter![0].task).toBe("cleanupChallenges");

    // ...and the sibling tasks still ran.
    expect(h.prisma.invite.deleteMany).toHaveBeenCalled();
    expect(h.reconcileAllTreasuryBalances).toHaveBeenCalled();

    const health = getWorkerHealth();
    expect(health.cyclesFailed).toBe(1);
    expect(health.lastCycleOutcome).toBe("failed");
    expect(health.deadLetteredTasks).toContain("cleanupChallenges");
  });
});
