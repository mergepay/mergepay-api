/**
 * Structured logging helpers for background worker task execution.
 *
 * Worker jobs — settlement submission, anchor reconciliation, treasury
 * proposal expiry, webhook delivery — all follow the same logging contract:
 * every line carries a job type, job identifier, execution attempt, and
 * outcome. These helpers enforce that contract at the call site so
 * individual job handlers cannot drift.
 *
 * Usage:
 *
 *   import { jobLogger } from "../lib/worker-logger";
 *   import { log } from "./index"; // the worker's parent pino instance
 *
 *   const job = jobLogger("settlement", settlementId, log);
 *   job.log("started", { attempt: 1 });
 *   // …
 *   job.log("completed", { attempt: 1, hash });
 */
import pino from "pino";
import {
  type CorrelationContext,
  jobContext,
  loggerWithContext,
} from "./correlation";
import { safeFailureMessage } from "../services/job-retry";

/** Standard outcomes reported by worker job helpers. */
export type JobOutcome =
  | "started"
  | "completed"
  | "failed"
  | "retry_scheduled"
  | "skipped"
  | "error"
  | "lease_recovered"
  | "lease_released"
  | string;

/**
 * A structured job logger that automatically includes job type, job ID,
 * and correlation context in every log entry.
 */
export interface JobLogger {
  /** The resolved correlation context, useful for passing to service calls. */
  readonly ctx: CorrelationContext;

  /** Log at info level with the standard job fields merged in. */
  log(outcome: JobOutcome, extra?: Record<string, unknown>, msg?: string): void;

  /** Log at warn level with the standard job fields merged in. */
  warn(outcome: JobOutcome, extra?: Record<string, unknown>, msg?: string): void;

  /** Log an error with the standard job fields, automatically serializing the error. */
  error(error: unknown, extra?: Record<string, unknown>, msg?: string): void;

  /** The underlying Pino logger (for advanced use). */
  readonly logger: pino.Logger;
}

/**
 * Create a structured job logger for a background worker task.
 *
 * @param jobType  The job family name (e.g. "settlement", "anchor", "webhook_delivery").
 * @param jobId    The unique identifier of the specific job instance.
 * @param parent   The parent Pino logger to derive from. Defaults to a bare root logger.
 * @param originatingCorrelationId  Optional correlation ID from the originating API request.
 */
export function jobLogger(
  jobType: string,
  jobId: string,
  parent: pino.Logger,
  originatingCorrelationId?: unknown
): JobLogger {
  const ctx = jobContext(jobType, jobId, originatingCorrelationId);
  const logger = loggerWithContext(parent, ctx);

  return {
    ctx,

    log(outcome, extra, msg) {
      logger.info(
        { jobType, jobId, outcome, ...extra },
        msg ?? `${jobType} ${outcome}`
      );
    },

    warn(outcome, extra, msg) {
      logger.warn(
        { jobType, jobId, outcome, ...extra },
        msg ?? `${jobType} ${outcome}`
      );
    },

    error(error, extra, msg) {
      logger.error(
        {
          jobType,
          jobId,
          outcome: "error",
          reason: safeFailureMessage(error),
          ...extra,
        },
        msg ?? `${jobType} error`
      );
    },

    logger,
  };
}
