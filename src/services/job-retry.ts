export type JobFailureCategory = "transient" | "permanent" | "indeterminate";

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
}

export const SETTLEMENT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  initialDelayMs: 1_000,
  maxDelayMs: 4_000,
};

/** Return the retry delay for an attempt, capped at maxDelayMs. */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy = SETTLEMENT_RETRY_POLICY
): number {
  if (!Number.isFinite(attempt) || attempt < 1) return 0;
  const exponent = Math.max(0, Math.floor(attempt) - 1);
  return Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** exponent);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return String(error);
}

/**
 * Classify only the failure classes that are safe to act on automatically.
 * Validation, authorization, and transaction rejection errors are terminal.
 */
export function classifyJobFailure(error: unknown): JobFailureCategory {
  const message = errorMessage(error).toLowerCase();

  if (
    message.includes("invalid") ||
    message.includes("malformed") ||
    message.includes("unauthoriz") ||
    message.includes("forbidden") ||
    message.includes("unauthenticated") ||
    message.includes("not authorized") ||
    message.includes("rejected the transaction") ||
    message.includes("tx_bad") ||
    message.includes("op_bad") ||
    message.includes("underfunded") ||
    message.includes("trustline")
  ) {
    return "permanent";
  }

  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("connection") ||
    message.includes("network") ||
    message.includes("rate_limit") ||
    message.includes("rate limit") ||
    message.includes("temporar") ||
    message.includes("service unavailable") ||
    message.includes("gateway") ||
    message.includes("stale") ||
    message.includes("econn") ||
    message.includes("socket")
  ) {
    return message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("connection") ||
      message.includes("network") ||
      message.includes("socket")
      ? "indeterminate"
      : "transient";
  }

  return "permanent";
}

/** Extract a provider transaction hash without logging the surrounding error. */
export function failureTransactionHash(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const value = error as {
    hash?: unknown;
    response?: { data?: { hash?: unknown; transaction_hash?: unknown } };
  };
  const candidate =
    value.hash ??
    value.response?.data?.hash ??
    value.response?.data?.transaction_hash;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}
