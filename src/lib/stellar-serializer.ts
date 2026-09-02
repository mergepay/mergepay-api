/**
 * Custom Pino serializer for Stellar SDK error objects.
 *
 * Stellar Horizon errors often carry circular references, verbose network
 * response structures, and nested problem-detail objects that clutter log
 * output and can cause JSON.stringify failures. This serializer safely
 * extracts the useful diagnostic fields — message, status code, problem
 * details, extras, and transaction result codes — into a flat, log-friendly
 * shape.
 */

/** The shape returned by the serializer for Stellar errors. */
export interface StellarSerializedError {
  /** Always present — a concise error description. */
  message: string;
  /** Pino/Fastify expects `type` to be a string (not optional). */
  type: string;
  name?: string;
  /** Pino/Fastify expects `stack` to always be a string. */
  stack: string;
  statusCode?: number;
  /** Horizon problem-detail `title`. */
  title?: string;
  /** Horizon problem-detail `detail`. */
  detail?: string;
  /** extras carried by the Horizon response (account, transaction, etc.). */
  extras?: Record<string, unknown>;
  /** Transaction result code extracted from a failed tx submission. */
  transactionResultCode?: string;
  /** Operation result codes, when present. */
  operationResultCodes?: string[];
  /** The original constructor name, useful for distinguishing SDK error classes. */
  errorType?: string;
}

interface StellarErrorLike extends Error {
  response?: { status?: number; data?: unknown };
  extras?: Record<string, unknown>;
  problem?: { type?: string; title?: string; detail?: string };
}

/**
 * Detect whether a value is a Stellar SDK error. The SDK throws plain Error
 * subclasses; the distinguishing markers are the `response` or `extras`
 * properties that Horizon attaches.
 */
function isStellarError(value: unknown): value is StellarErrorLike {
  if (!value || typeof value !== "object") return false;
  if (!(value instanceof Error)) return false;
  const err = value as unknown as Record<string, unknown>;
  // Horizon errors carry a `response` property; some also carry `extras`.
  return "response" in err || "extras" in err || "problem" in err;
}

/**
 * Safely extract transaction result codes from a Horizon error response.
 *
 * The result XDR can be deep and verbose; we pull only the human-readable
 * codes rather than the full decoded structure.
 */
function extractResultCodes(
  data: unknown
): { transactionResultCode?: string; operationResultCodes?: string[] } {
  if (!data || typeof data !== "object") return {};
  const obj = data as Record<string, unknown>;
  const result = obj.result as Record<string, unknown> | undefined;
  if (!result) return {};

  const transactionResultCode = result.transaction_result_code as
    | string
    | undefined;

  const operationResultCodes = Array.isArray(result.operations)
    ? (result.operations as Record<string, unknown>[])
        .map((op) => op.operation_result_code)
        .filter((c): c is string => typeof c === "string")
    : undefined;

  return { transactionResultCode, operationResultCodes };
}

/**
 * Pino-compatible serializer for Stellar SDK errors.
 *
 * Returns a plain object with only the fields safe for structured logging.
 * Circular references and bulky response bodies are intentionally omitted.
 *
 * The returned `type` field is always a string: either the Horizon
 * problem-detail type or a fallback like `"StellarError"`.
 */
export function stellarErrorSerializer(error: unknown): StellarSerializedError {
  if (!isStellarError(error)) {
    // Not a Stellar error — fall back to a minimal representation.
    if (error instanceof Error) {
      return {
        message: error.message,
        type: error.name || "Error",
        name: error.name,
        stack: error.stack ?? "",
      };
    }
    return { message: String(error), type: "Error", stack: "" };
  }

  const err = error;

  const statusCode = err.response?.status;
  const problem = err.problem;

  const { transactionResultCode, operationResultCodes } = extractResultCodes(
    err.response?.data
  );

  const serialized: StellarSerializedError = {
    message: err.message,
    type: problem?.type ?? "StellarError",
    name: err.name,
    stack: err.stack ?? "",
    errorType: err.constructor?.name,
  };

  if (statusCode !== undefined) {
    serialized.statusCode = statusCode;
  }
  if (problem?.title) {
    serialized.title = problem.title;
  }
  if (problem?.detail) {
    serialized.detail = problem.detail;
  }
  if (err.extras && Object.keys(err.extras).length > 0) {
    // Shallow copy to avoid leaking circular references.
    serialized.extras = { ...err.extras };
  }
  if (transactionResultCode) {
    serialized.transactionResultCode = transactionResultCode;
  }
  if (operationResultCodes && operationResultCodes.length > 0) {
    serialized.operationResultCodes = operationResultCodes;
  }

  return serialized;
}
