/**
 * Worker health monitoring and in-cycle retries — issue #708.
 *
 * Before this module the worker answered "what happens when something fails?"
 * at two different layers. Job rows (settlements, anchor sessions) carry their
 * own bounded, database-persisted retry budgets — see src/services/job-retry.ts
 * and the claim/scheduleRetry/failSettlement flow in src/worker/index.ts. But
 * the *tasks* that drive those rows did not: `runWorkerCycle` ran every batch
 * task under `Promise.allSettled`, so a task that threw — a transient database
 * outage, a Horizon rate limit — was swallowed without a retry *and* without a
 * log line, and whatever jobs it owed that cycle simply waited for the next
 * one, invisibly.
 *
 * This module adds the two missing layers:
 *
 *  **`withRetry` — a retry wrapper for cycle tasks.** A task that fails with a
 *  *transient* error is retried in-cycle with the same bounded, jittered
 *  exponential backoff the per-job policies use (`retryDelayMs`). Permanent
 *  failures propagate immediately — retrying a rejected request cannot help.
 *  *Indeterminate* failures (timeouts, dropped sockets) propagate too: unlike
 *  a settlement submission, a batch task cannot ask the ledger whether it
 *  "took effect", so the safe answer is to let the next cycle re-run the sweep
 *  rather than double-execute it mid-cycle. The budget is configurable via the
 *  `WORKER_CYCLE_TASK_*` environment variables.
 *
 *  **A health registry + heartbeat.** Every cycle records its start, outcome,
 *  and duration; every completed cycle emits a structured `worker_health`
 *  heartbeat log so an operator (or log-based alerting) can see at a glance
 *  whether the loop is alive and whether cycles fail repeatedly. A worker
 *  whose consecutive failed cycles reach `WORKER_HEALTH_UNHEALTHY_THRESHOLD`
 *  reports `healthy: false`. A task whose in-cycle budget is exhausted is
 *  logged as a critical `dead_letter` error — that is its dead-letter signal,
 *  because sweep tasks carry no persistent row of their own to fail (the job
 *  rows underneath them keep their own failed/`error` terminal states).
 */

import pino from "pino";
import { config } from "../config";
import {
  classifyJobFailure,
  retryDelayMs,
  safeFailureMessage,
  type RetryPolicy,
} from "../services/job-retry";

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/**
 * Bounded retry budget for one *cycle task* invocation (the batch jobs inside
 * `runWorkerCycle`). This governs how many times a task that itself throws —
 * a transient database or Horizon error — is retried before the cycle gives
 * up on it and logs a critical error. It is deliberately separate from the
 * per-job budgets (`WORKER_SETTLEMENT_*`, `WORKER_ANCHOR_*`), which govern how
 * many times an individual job row is submitted or polled.
 */
export const CYCLE_TASK_RETRY_POLICY: RetryPolicy = {
  maxAttempts: config.WORKER_CYCLE_TASK_MAX_ATTEMPTS,
  initialDelayMs: config.WORKER_CYCLE_TASK_RETRY_INITIAL_DELAY_MS,
  maxDelayMs: config.WORKER_CYCLE_TASK_RETRY_MAX_DELAY_MS,
  // Jitter follows the same ratio the per-job policies default to, kept
  // constant here so a fleet of workers recovering from the same outage does
  // not resubmit in lockstep without another knob to misconfigure.
  jitterRatio: 0.25,
};

export interface WorkerRetryOptions {
  /** Task name for logging and health attribution. */
  taskName: string;
  /** Retry budget; defaults to the cycle-task policy above. */
  policy?: RetryPolicy;
  /**
   * Sleep between attempts. Injectable so tests can drive the backoff
   * schedule without real time passing (the same pattern as the worker's
   * `setDelayFn`).
   */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each scheduled retry (not on success or final failure). */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    category: "transient" | "indeterminate" | "permanent";
    reason: string;
  }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task`, retrying while it fails with a *transient* error.
 *
 * - Success returns the task's value; the task runs at most `maxAttempts` times.
 * - A permanent failure throws immediately: classification comes from
 *   `classifyJobFailure`, so a 4xx or a rejected transaction never burns the
 *   budget.
 * - An indeterminate failure (timeout, dropped socket) also throws: see the
 *   module comment — a batch task cannot check whether it took effect, so the
 *   next cycle re-runs the sweep instead.
 * - An exhausted budget throws the last error, so the caller sees the real
 *   failure and can log it as critical.
 */
export async function withRetry<T>(
  task: () => Promise<T>,
  options: WorkerRetryOptions
): Promise<T> {
  const policy = options.policy ?? CYCLE_TASK_RETRY_POLICY;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const category = classifyJobFailure(error);
      const reason = safeFailureMessage(error);

      // Only a demonstrably-not-taken transient failure is retried here.
      // Permanent failures can never succeed on retry; indeterminate ones are
      // handed to the next cycle rather than double-executed mid-cycle.
      if (category !== "transient" || attempt >= policy.maxAttempts) {
        throw error;
      }

      const delayMs = retryDelayMs(attempt, policy);
      options.onRetry?.({ attempt, delayMs, category, reason });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on its final attempt.
  throw new Error("withRetry exited its loop without a result");
}

// ---------------------------------------------------------------------------
// Health registry
// ---------------------------------------------------------------------------

export type WorkerCycleOutcome = "never_run" | "running" | "success" | "failed";

export interface WorkerHealth {
  workerId: string;
  healthy: boolean;
  startedAt: string;
  lastCycleStartedAt: string | null;
  lastCycleCompletedAt: string | null;
  lastCycleDurationMs: number | null;
  lastCycleOutcome: WorkerCycleOutcome;
  cyclesCompleted: number;
  cyclesFailed: number;
  /** Consecutive failed cycles; reset by any successful one. */
  consecutiveFailures: number;
  /** Final (budget-exhausted) failures per cycle task, by task name. */
  taskFailures: Record<string, number>;
  /** Tasks whose in-cycle retry budget was exhausted, newest first. */
  deadLetteredTasks: string[];
}

const state = {
  workerId: "unknown",
  startedAt: new Date().toISOString(),
  lastCycleStartedAt: null as string | null,
  lastCycleCompletedAt: null as string | null,
  cycleStartedAtMs: null as number | null,
  lastCycleDurationMs: null as number | null,
  lastCycleOutcome: "never_run" as WorkerCycleOutcome,
  cyclesCompleted: 0,
  cyclesFailed: 0,
  consecutiveFailures: 0,
  taskFailures: {} as Record<string, number>,
  deadLetteredTasks: [] as string[],
};

/** Bind the registry to this worker process. Called once at module load. */
export function initWorkerHealth(workerId: string): void {
  state.workerId = workerId;
  state.startedAt = new Date().toISOString();
}

/** Mark the current cycle as started. */
export function recordCycleStart(): void {
  state.lastCycleStartedAt = new Date().toISOString();
  state.cycleStartedAtMs = Date.now();
  state.lastCycleOutcome = "running";
}

/** Record a cycle that finished with no dead-lettered task. */
export function recordCycleSuccess(): void {
  state.lastCycleCompletedAt = new Date().toISOString();
  state.lastCycleDurationMs =
    state.cycleStartedAtMs !== null ? Date.now() - state.cycleStartedAtMs : null;
  state.lastCycleOutcome = "success";
  state.cyclesCompleted += 1;
  state.consecutiveFailures = 0;
}

/** Record a cycle in which at least one task exhausted its retry budget. */
export function recordCycleFailure(reason: string): void {
  void reason;
  state.lastCycleCompletedAt = new Date().toISOString();
  state.lastCycleDurationMs =
    state.cycleStartedAtMs !== null ? Date.now() - state.cycleStartedAtMs : null;
  state.lastCycleOutcome = "failed";
  state.cyclesFailed += 1;
  state.consecutiveFailures += 1;
}

/** Count a final (budget-exhausted) failure of one cycle task. */
export function recordTaskFailure(taskName: string): void {
  state.taskFailures[taskName] = (state.taskFailures[taskName] ?? 0) + 1;
}

/** Remember that a task's in-cycle retry budget was exhausted. */
export function recordTaskDeadLetter(taskName: string): void {
  state.deadLetteredTasks.unshift(taskName);
  // Bounded: a permanently failing task in an unhealthy deployment must not
  // grow this list without limit.
  if (state.deadLetteredTasks.length > 50) {
    state.deadLetteredTasks.length = 50;
  }
}

/** A point-in-time snapshot; mutations never leak through the copy. */
export function getWorkerHealth(): WorkerHealth {
  return {
    workerId: state.workerId,
    healthy: state.consecutiveFailures < config.WORKER_HEALTH_UNHEALTHY_THRESHOLD,
    startedAt: state.startedAt,
    lastCycleStartedAt: state.lastCycleStartedAt,
    lastCycleCompletedAt: state.lastCycleCompletedAt,
    lastCycleDurationMs: state.lastCycleDurationMs,
    lastCycleOutcome: state.lastCycleOutcome,
    cyclesCompleted: state.cyclesCompleted,
    cyclesFailed: state.cyclesFailed,
    consecutiveFailures: state.consecutiveFailures,
    taskFailures: { ...state.taskFailures },
    deadLetteredTasks: [...state.deadLetteredTasks],
  };
}

/** Test isolation: reset the registry between tests. */
export function resetWorkerHealth(): void {
  state.workerId = "unknown";
  state.startedAt = new Date().toISOString();
  state.lastCycleStartedAt = null;
  state.lastCycleCompletedAt = null;
  state.cycleStartedAtMs = null;
  state.lastCycleDurationMs = null;
  state.lastCycleOutcome = "never_run";
  state.cyclesCompleted = 0;
  state.cyclesFailed = 0;
  state.consecutiveFailures = 0;
  state.taskFailures = {};
  state.deadLetteredTasks = [];
}

// ---------------------------------------------------------------------------
// Structured health logging
// ---------------------------------------------------------------------------

/** Emit the per-cycle heartbeat: one structured line describing worker health. */
export function logHealthHeartbeat(parent: pino.Logger): void {
  parent.info(
    { jobType: "worker_health", outcome: "heartbeat", health: getWorkerHealth() },
    "worker heartbeat"
  );
}

/**
 * Emit the critical health signal — consecutive failed cycles crossed the
 * configured threshold, or a task exhausted its retry budget while the worker
 * is already unhealthy.
 */
export function logHealthCritical(parent: pino.Logger, reason: string): void {
  parent.error(
    {
      jobType: "worker_health",
      outcome: "critical",
      reason: safeFailureMessage(reason),
      health: getWorkerHealth(),
    },
    "worker health critical"
  );
}
