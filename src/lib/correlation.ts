import { randomUUID } from "node:crypto";
import pino from "pino";

/**
 * Correlation IDs are intentionally conservative because they are written to
 * structured logs and may be copied into response headers and audit metadata.
 */
export const CORRELATION_ID_MAX_LENGTH = 128;

// Keep the accepted alphabet free from whitespace, control characters, and
// structured-log delimiters. UUIDs and common trace-id formats are supported.
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Return true when a value is a bounded, log-safe correlation ID. */
export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

/** Generate a server-owned correlation ID. */
export function createCorrelationId(): string {
  return `req_${randomUUID()}`;
}

/**
 * Resolve an incoming request ID without ever trusting malformed client input.
 * Header arrays and all values containing unsafe characters are rejected.
 */
export function getCorrelationId(value: unknown): string {
  return isValidCorrelationId(value) ? value : createCorrelationId();
}

/** Resolve a correlation ID for a queued worker job. */
export function getWorkerCorrelationId(originatingId?: unknown): string {
  return getCorrelationId(originatingId);
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
