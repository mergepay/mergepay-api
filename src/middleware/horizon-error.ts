/**
 * Horizon / Stellar SDK error mapping for the API error handler (#1083).
 *
 * Turns a failure thrown by the Stellar SDK into a clean API error plus a
 * structured log record. Only allow-listed fields ever leave this module:
 * validated result-code tokens, the HTTP status, and a short operation label.
 * Request bodies, signed XDR envelopes, `result_xdr`, secrets and raw upstream
 * messages are never copied into either the response or the log fields.
 */
import { mapHorizonError } from "../services/horizon-errors";

export interface HorizonFailureResolution {
  /** HTTP status for the API response. */
  status: number;
  /** Stable machine-readable API error code. */
  code: string;
  /** Client-safe message. */
  message: string;
  /** Client-safe details (hint + validated result codes), if any. */
  details?: { hint: string; resultCodes: string[] };
  /** Safe structured log fields. */
  logFields: Record<string, unknown>;
  /** Log level: client-correctable rejections are warn, outages are error. */
  level: "warn" | "error";
}

const TIMEOUT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function upstreamStatusOf(error: Record<string, unknown>): number | undefined {
  const response = asRecord(error.response);
  const candidate = response?.status ?? error.status;
  return typeof candidate === "number" ? candidate : undefined;
}

/**
 * Resolve a Horizon failure, or `null` when `error` is not one this module
 * understands (the caller falls through to its generic handling).
 *
 * - Ledger rejections (`result_codes` / `result_xdr`) map to the stable
 *   `STELLAR_*` codes from `services/horizon-errors`.
 * - Network timeouts (no HTTP response) map to 504 `UPSTREAM_TIMEOUT`.
 */
export function resolveHorizonFailure(
  error: unknown,
  operation = "Horizon request"
): HorizonFailureResolution | null {
  const root = asRecord(error);
  if (!root) return null;

  const mapping = mapHorizonError(error);
  if (mapping) {
    const upstreamStatus = upstreamStatusOf(root);
    return {
      status: mapping.status,
      code: mapping.code,
      message: mapping.message,
      details: { hint: mapping.hint, resultCodes: mapping.resultCodes },
      logFields: {
        operation,
        errorCode: mapping.code,
        resultCodes: mapping.resultCodes,
        ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      },
      level: mapping.status >= 500 ? "error" : "warn",
    };
  }

  const code = typeof root.code === "string" ? root.code : undefined;
  if (code && TIMEOUT_CODES.has(code) && upstreamStatusOf(root) === undefined) {
    return {
      status: 504,
      code: "UPSTREAM_TIMEOUT",
      message: `${operation} timed out while contacting the Stellar network. Please retry shortly.`,
      logFields: { operation, errorCode: "UPSTREAM_TIMEOUT", networkCode: code },
      level: "error",
    };
  }

  return null;
}
