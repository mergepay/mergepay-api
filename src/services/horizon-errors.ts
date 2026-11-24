import { xdr } from "@stellar/stellar-sdk";

/**
 * Translation layer for Stellar Horizon failures — issue #810.
 *
 * `@stellar/stellar-sdk` throws errors whose useful information lives two
 * levels deep: an HTTP `response.data.extras.result_codes` object and a
 * base64 `result_xdr` describing the ledger's verdict. Neither is safe or
 * readable to hand to a client verbatim, and the generic `PROVIDER_REJECTED`
 * answer ("the upstream said no") does not tell a wallet what to do next.
 *
 * This module reduces both shapes to a small, allow-listed vocabulary of
 * result-code tokens and maps the common ones onto a stable API code, an HTTP
 * status, and an actionable hint. Anything unrecognized still becomes
 * `PROVIDER_REJECTED`, but only the validated result-code tokens survive — the
 * raw payload, operation details, and upstream message text never do.
 */

export interface HorizonResultMapping {
  /** HTTP status the API should answer with. */
  status: number;
  /** Stable machine-readable API error code. */
  code: string;
  /** Client-safe description of what the ledger rejected. */
  message: string;
  /** Actionable guidance for the client. */
  hint: string;
  /** Every safe result-code token extracted from the failure. */
  resultCodes: string[];
}

type KnownMapping = Pick<
  HorizonResultMapping,
  "status" | "code" | "message" | "hint"
>;

/**
 * Common Horizon / Stellar Core result codes and the remedy each implies.
 *
 * Codes are grouped by failure family so related conditions answer
 * consistently. A code absent here is not an error: it still returns a
 * `PROVIDER_REJECTED` mapping carrying the validated tokens.
 */
const RESULT_MAPPINGS: Record<string, KnownMapping> = {
  // ── Transaction-level rejections ──────────────────────────────────────
  tx_bad_seq: {
    status: 409,
    code: "STELLAR_SEQUENCE_CONFLICT",
    message: "The Stellar account sequence is out of date.",
    hint: "Refresh the account and rebuild the transaction before signing again.",
  },
  tx_bad_min_seq_age_or_gap: {
    status: 409,
    code: "STELLAR_SEQUENCE_CONFLICT",
    message: "The Stellar transaction's sequence preconditions were not met.",
    hint: "Refresh the account and rebuild the transaction before signing again.",
  },
  tx_insufficient_balance: {
    status: 422,
    code: "STELLAR_INSUFFICIENT_FUNDS",
    message: "The Stellar account does not have enough balance for this transaction.",
    hint: "Add funds for the payment, network fee, and required reserve.",
  },
  tx_insufficient_fee: {
    status: 422,
    code: "STELLAR_FEE_TOO_LOW",
    message: "The Stellar transaction fee was not sufficient.",
    hint: "Rebuild the transaction with a current network fee and sign it again.",
  },
  tx_bad_auth: {
    status: 422,
    code: "STELLAR_AUTH_FAILED",
    message: "The Stellar transaction does not contain the required signatures.",
    hint: "Sign the exact transaction with the account's currently authorized signer keys.",
  },
  tx_bad_auth_extra: {
    status: 422,
    code: "STELLAR_AUTH_FAILED",
    message: "The Stellar transaction carries signatures from unauthorized signers.",
    hint: "Remove signatures from keys that are not authorized on the source account.",
  },
  tx_too_late: {
    status: 422,
    code: "STELLAR_TRANSACTION_EXPIRED",
    message: "The Stellar transaction expired before it could be submitted.",
    hint: "Build and sign a fresh transaction.",
  },
  tx_too_early: {
    status: 422,
    code: "STELLAR_TRANSACTION_NOT_YET_VALID",
    message: "The Stellar ledger has not reached the transaction's validity window.",
    hint: "Wait for the transaction's minimum time bound, or rebuild it with current bounds.",
  },
  tx_no_account: {
    status: 422,
    code: "STELLAR_ACCOUNT_NOT_FOUND",
    message: "The Stellar source account does not exist.",
    hint: "Fund the source account before submitting transactions from it.",
  },
  tx_missing_operation: {
    status: 422,
    code: "STELLAR_TRANSACTION_MALFORMED",
    message: "The Stellar transaction does not contain any operations.",
    hint: "Build the transaction with at least one operation and sign it again.",
  },
  tx_malformed: {
    status: 422,
    code: "STELLAR_TRANSACTION_MALFORMED",
    message: "The Stellar transaction's preconditions are invalid.",
    hint: "Rebuild the transaction with valid preconditions and sign it again.",
  },
  tx_not_supported: {
    status: 422,
    code: "STELLAR_TRANSACTION_NOT_SUPPORTED",
    message: "The Stellar network does not support this transaction type.",
    hint: "Use a transaction type supported by the target network.",
  },
  tx_internal_error: {
    status: 502,
    code: "STELLAR_INTERNAL_ERROR",
    message: "Stellar could not process the transaction.",
    hint: "Retry the submission; if it persists, inspect the transaction against a current ledger.",
  },

  // ── Operation-level rejections ────────────────────────────────────────
  op_underfunded: {
    status: 422,
    code: "STELLAR_INSUFFICIENT_FUNDS",
    message: "The Stellar account does not have enough balance for this operation.",
    hint: "Add funds for the payment, network fee, and required reserve.",
  },
  op_low_reserve: {
    status: 422,
    code: "STELLAR_INSUFFICIENT_FUNDS",
    message: "The Stellar account would fall below its required reserve.",
    hint: "Top up the account so it can cover its reserve after this operation.",
  },
  op_no_destination: {
    status: 422,
    code: "STELLAR_DESTINATION_INVALID",
    message: "The Stellar destination account does not exist.",
    hint: "Verify the destination account and ensure it has been funded.",
  },
  op_no_trust: {
    status: 422,
    code: "STELLAR_MISSING_TRUSTLINE",
    message: "The destination account does not trust the asset being sent.",
    hint: "Establish the required trustline on the destination account first.",
  },
  op_src_no_trust: {
    status: 422,
    code: "STELLAR_MISSING_TRUSTLINE",
    message: "The source account does not trust the asset being sent.",
    hint: "Establish the required trustline on the source account first.",
  },
  op_not_authorized: {
    status: 422,
    code: "STELLAR_NOT_AUTHORIZED",
    message: "The destination account is not authorized to hold the asset.",
    hint: "Have the asset issuer authorize the destination account.",
  },
  op_src_not_authorized: {
    status: 422,
    code: "STELLAR_NOT_AUTHORIZED",
    message: "The source account is not authorized to hold the asset.",
    hint: "Have the asset issuer authorize the source account.",
  },
  op_line_full: {
    status: 422,
    code: "STELLAR_TRUSTLINE_LIMIT",
    message: "The destination trustline limit would be exceeded.",
    hint: "Raise the destination trustline limit or send a smaller amount.",
  },
  op_no_issuer: {
    status: 422,
    code: "STELLAR_ASSET_ISSUER_INVALID",
    message: "The asset issuer account does not exist.",
    hint: "Verify the asset issuer's public key.",
  },
  op_malformed: {
    status: 422,
    code: "STELLAR_OPERATION_MALFORMED",
    message: "The Stellar operation is malformed.",
    hint: "Rebuild the operation with valid parameters and sign it again.",
  },
};

/**
 * Horizon / Stellar Core result codes that describe the envelope itself as
 * invalid. Retrying the same envelope can never succeed, so every retry
 * classifier in the codebase must agree on this set.
 *
 * Kept here — beside the client-facing mappings above — so the API response
 * category, the read-retry policy (`src/services/horizon-retry.ts`), and the
 * generic retry utility (`src/utils/retry.ts`) cannot drift apart.
 */
export const PERMANENT_HORIZON_RESULT_CODES: ReadonlySet<string> = new Set([
  // Transaction-level rejections
  "tx_bad_auth",
  "tx_bad_auth_extra",
  "tx_bad_seq",
  "tx_bad_min_seq_age_or_gap",
  "tx_insufficient_fee",
  "tx_too_late",
  "tx_too_early",
  "tx_no_account",
  "tx_missing_operation",
  "tx_malformed",
  "tx_not_supported",
  "tx_failed",
  // Operation-level rejections
  "op_underfunded",
  "op_no_destination",
  "op_no_trust",
  "op_src_no_trust",
  "op_not_authorized",
  "op_src_not_authorized",
  "op_line_full",
  "op_no_issuer",
  "op_malformed",
]);

/**
 * Result-code-shaped tokens embedded in free-form error text.
 *
 * Some failures reach a retry classifier as a plain `Error` whose message
 * carries the ledger verdict (`"tx_bad_seq"`) but none of the structured
 * response fields. Extracting the tokens here — with the same grammar and
 * permanent-code classification as the structured path — keeps message-based
 * fallbacks on the same vocabulary instead of each caller maintaining its own
 * substring list.
 */
export function extractResultCodeTokens(text: string): string[] {
  const matches = text.match(/\b(?:tx|op)_[a-z0-9_]+\b/g) ?? [];
  return [...new Set(matches.filter((code) => safeCode(code) !== null))];
}

/**
 * Whether a result code is a permanent rejection (retrying cannot help).
 *
 * Codes outside the set are treated as transient by callers: a concurrent
 * payment may free up the balance (`tx_insufficient_balance`,
 * `op_low_reserve`), and an unrecognized code is more safely retried under a
 * bounded budget than failed outright.
 */
export function isPermanentHorizonResultCode(code: string): boolean {
  return PERMANENT_HORIZON_RESULT_CODES.has(code);
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Keep only Horizon result-code-shaped tokens. */
function safeCode(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,80}$/.test(value)
    ? value
    : null;
}

/**
 * Flatten `{ transaction: "tx_failed", operations: ["op_underfunded"] }` into
 * a de-duplicated list of validated codes, preserving order (transaction
 * verdict first, then the operations that actually failed).
 */
function codesFromResultCodes(value: unknown): string[] {
  const source = record(value);
  if (!source) return [];
  const codes: string[] = [];
  for (const entry of Object.values(source)) {
    const values = Array.isArray(entry) ? entry : [entry];
    for (const candidate of values) {
      const code = safeCode(candidate);
      if (code !== null && !codes.includes(code)) codes.push(code);
    }
  }
  return codes;
}

/**
 * Convert an XDR enum member name (`txBadSeq`, `opUnderfunded`, …) to the
 * snake_case result-code vocabulary Horizon reports (`tx_bad_seq`, …).
 */
export function enumNameToResultCode(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Read the authoritative transaction-level result code out of a base64
 * `result_xdr`.
 *
 * `TransactionResult.result().switch()` returns the enum member instance,
 * whose `name` carries the code — the generated enum's static members are
 * factory functions, so comparing against them would never match.
 */
function codeFromResultXdr(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const result = xdr.TransactionResult.fromXDR(value, "base64");
    const resultSwitch = result.result().switch();
    return enumNameToResultCode(resultSwitch.name);
  } catch {
    return null;
  }
}

/**
 * Extract every validated result-code token from a Stellar SDK / Horizon
 * error, in the order the ledger reported them.
 *
 * This is the single extraction path for the API's error mapping, the Horizon
 * retry classifier, and the generic retry utility. It reads both the
 * structured `extras.result_codes` object and the authoritative `result_xdr`,
 * and only keeps allow-listed tokens — raw payloads never escape.
 *
 * @returns The transaction-level verdict first, then the failed operations;
 *   `[]` when the error carries no ledger result codes (transport, timeout, or
 *   an unrelated SDK failure).
 */
export function extractHorizonResultCodes(error: unknown): string[] {
  const root = record(error);
  const response = record(root?.response);
  const data = record(response?.data) ?? record(root?.data);
  if (!data) return [];

  const extras = record(data.extras);
  const resultCodes = codesFromResultCodes(
    extras?.result_codes ?? data.result_codes
  );

  // `result_xdr` is authoritative for the transaction-level verdict; prepend
  // it so it wins over an operation code when both describe the same failure.
  const xdrCode = codeFromResultXdr(extras?.result_xdr ?? data.result_xdr);
  if (xdrCode && !resultCodes.includes(xdrCode)) resultCodes.unshift(xdrCode);

  return resultCodes;
}

/**
 * Inspect a Stellar SDK / Horizon error and map it onto a client-safe
 * response, or return `null` when the error does not describe a ledger
 * rejection (transport failure, timeout, anchor error, …).
 *
 * Non-null results always carry at least one validated result-code token, so
 * the caller can treat their presence as "the provider definitively rejected
 * this transaction".
 */
export function mapHorizonError(error: unknown): HorizonResultMapping | null {
  const resultCodes = extractHorizonResultCodes(error);

  for (const resultCode of resultCodes) {
    const mapping = RESULT_MAPPINGS[resultCode];
    if (mapping) return { ...mapping, resultCodes };
  }

  return resultCodes.length > 0
    ? {
        status: 502,
        code: "PROVIDER_REJECTED",
        message: "Stellar rejected the transaction.",
        hint: "Review the transaction result codes before submitting a corrected transaction.",
        resultCodes,
      }
    : null;
}
