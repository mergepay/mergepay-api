/**
 * Background worker job error retry and dead-letter handling (#881).
 *
 * Provides a standardized execution loop for worker tasks, incorporating:
 * - Retry counter tracking and limit enforcement
 * - Exponential backoff with jitter
 * - Transient error recovery vs permanent failure fast-abort
 * - Dead-letter logging and database status transition to "failed"
 */
import { createLogger } from "../lib/logger";
import { jobLogger } from "../lib/worker-logger";
import {
  asJobError,
  retryDelayMs,
  type JobFailureCategory,
  type RetryPolicy,
} from "../services/job-retry";

const log = createLogger({ name: "worker:retry-handler" });

export interface WorkerJobExecutionOptions {
  taskName: string;
  /** Job family used in structured logs; defaults to `worker_task`. */
  jobType?: string;
  jobId?: string;
  userId?: string | null;
  groupId?: string | null;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
  auditDeadLetter?: boolean;
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    category: JobFailureCategory;
    reason: string;
    error: unknown;
  }) => void | Promise<void>;
  onDeadLetter?: (info: {
    attempts: number;
    category: JobFailureCategory;
    reason: string;
    error: unknown;
  }) => Promise<void>;
}

export interface WorkerJobExecutionResult<T> {
  success: boolean;
  result?: T;
  error?: unknown;
  attempts: number;
  deadLettered: boolean;
}

export const DEFAULT_WORKER_JOB_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
  jitterRatio: 0.1,
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function executeWorkerJobWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: WorkerJobExecutionOptions
): Promise<WorkerJobExecutionResult<T>> {
  const policy = options.policy ?? DEFAULT_WORKER_JOB_POLICY;
  const sleep = options.sleep ?? defaultSleep;
  const taskName = options.taskName;
  const jobType = options.jobType ?? "worker_task";
  const jobId = options.jobId ?? taskName;
  const job = jobLogger(jobType, jobId, log);

  let lastError: unknown;

  job.log("started", {
    task: taskName,
    attempt: 1,
    maxAttempts: policy.maxAttempts,
  });

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const result = await task(attempt);
      job.log("completed", {
        task: taskName,
        attempt,
        maxAttempts: policy.maxAttempts,
      });
      return {
        success: true,
        result,
        attempts: attempt,
        deadLettered: false,
      };
    } catch (error) {
      lastError = error;
      const classified = asJobError(error);
      const { category, retryable, message: reason } = classified;

      if (!retryable || attempt >= policy.maxAttempts) {
        job.error(error, {
          task: taskName,
          attempt,
          attempts: attempt,
          maxAttempts: policy.maxAttempts,
          category,
          retryable,
          reason,
          outcome: "dead_letter",
        });

        if (options.onDeadLetter) {
          await options.onDeadLetter({
            attempts: attempt,
            category,
            reason,
            error,
          });
        }

        return {
          success: false,
          error,
          attempts: attempt,
          deadLettered: true,
        };
      }

      const delayMs = retryDelayMs(attempt, policy);
      job.warn("retry_scheduled", {
        task: taskName,
        attempt,
        maxAttempts: policy.maxAttempts,
        category,
        retryable,
        delayMs,
        reason,
        err: error,
      });

      if (options.onRetry) {
        await options.onRetry({
          attempt,
          delayMs,
          category,
          reason,
          error,
        });
      }

      await sleep(delayMs);
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: policy.maxAttempts,
    deadLettered: true,
  };
}
