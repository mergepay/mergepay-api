import { randomUUID } from "node:crypto";

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
