import { randomUUID } from "node:crypto";
import pino from "pino";

/**
 * Correlation IDs are intentionally restricted to a small header-safe alphabet
 * and bounded to prevent log-field injection and unbounded log data.
 */
export const CORRELATION_ID_MAX_LENGTH = 64;
export const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= CORRELATION_ID_MAX_LENGTH &&
    CORRELATION_ID_PATTERN.test(value)
  );
}

export function generateCorrelationId(): string {
  return randomUUID();
}

export function getCorrelationId(value: unknown): string {
  return isValidCorrelationId(value) ? value : generateCorrelationId();
}

/**
 * Stable correlation ID for a background job. The job identity, rather than
 * an attempt number, is used so retries remain connected in logs.
 */
export function jobCorrelationId(jobType: string, jobId: string): string {
  const normalisedType = jobType.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 24);
  const normalisedId = jobId.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 34);
  return getCorrelationId(`job-${normalisedType}-${normalisedId}`);
}

/**
 * Bounded context object passed through service and worker calls so that
 * structured logs and audit trails can include the originating request.
 */
export interface CorrelationContext {
  correlationId: string;
  jobId?: string;
}

/**
 * Derive a correlation context for a background job. When an originating
 * correlation ID from an API request is not available, the context is
 * derived deterministically from the job type and ID so that retries
 * across worker cycles share the same correlation ID.
 */
export function jobContext(
  jobType: string,
  jobId: string,
  originatingCorrelationId?: string
): CorrelationContext {
  return {
    correlationId: originatingCorrelationId ?? jobCorrelationId(jobType, jobId),
    jobId,
  };
}

/**
 * Return a child logger that includes correlation fields. This is safe to
 * call even when ctx is undefined — a bare logger is returned in that case.
 */
export function loggerWithContext(
  parent: pino.Logger,
  ctx?: CorrelationContext
): pino.Logger {
  if (!ctx) return parent;
  return parent.child({
    correlationId: ctx.correlationId,
    ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
  });
}
