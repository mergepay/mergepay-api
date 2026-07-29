import { randomUUID } from "node:crypto";

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
