/**
 * Parse and validate Stellar transaction memo strings that follow the
 * Mergepay `MP:<code>` convention.
 *
 * Mergepay uses these memos to link on-chain Stellar payments to group
 * expenses and settlements. This helper ensures:
 *
 *  1. The memo has the required `MP:` prefix.
 *  2. The payload fits Stellar's 28-byte MEMO_TEXT limit.
 *  3. The code contains only characters from the approved short-code
 *     alphabet (uppercase A-Z minus I/O, plus 2-9 — no ambiguous chars).
 *
 * This module is pure — no I/O, no Horizon, no Prisma — so it can be
 * imported anywhere without pulling in side effects.
 */

import { ALPHABET } from "../services/codes";

/** Prefix that marks a memo as a Mergepay payment intent reference. */
export const MP_PREFIX = "MP:" as const;

/** Maximum byte length for a Stellar MEMO_TEXT payload. */
export const MAX_MEMO_BYTES = 28 as const;

/** Minimum valid memo: the prefix plus at least one code character. */
const MIN_MEMO_LENGTH = MP_PREFIX.length + 1;

// ---------------------------------------------------------------------------
// Result types (follows the lib/money.ts convention — no throws)
// ---------------------------------------------------------------------------

export interface MemoParseOk {
  ok: true;
  /** The extracted code portion (everything after `MP:`). */
  code: string;
  /** The full original memo string. */
  memo: string;
}

export interface MemoParseErr {
  ok: false;
  /** Human-readable reason the memo is invalid. */
  message: string;
}

export type MemoParseResult = MemoParseOk | MemoParseErr;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const VALID_CODE_RE = new RegExp(`^[${ALPHABET.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}]+$`);

/**
 * Check whether a single character is in the approved short-code alphabet.
 * Exported for callers that need character-level validation (e.g. building
 * custom error messages or filtering user input).
 */
export function isValidCodeChar(ch: string): boolean {
  return VALID_CODE_RE.test(ch);
}

/**
 * Validate that an entire code string contains only approved characters.
 *
 * Returns `true` if every character is in the Mergepay ALPHABET
 * (uppercase A-Z minus I/O, plus 2-9). Empty strings return `false`.
 */
export function isValidMemoCode(code: string): boolean {
  if (code.length === 0) return false;
  return VALID_CODE_RE.test(code);
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a raw Stellar memo string and extract the Mergepay code.
 *
 * ```ts
 * parseMemo("MP:ABC123DEF0");
 * // => { ok: true, code: "ABC123DEF0", memo: "MP:ABC123DEF0" }
 *
 * parseMemo("hello");
 * // => { ok: false, message: "Mergepay memo must start with 'MP:'." }
 * ```
 *
 * This function does **not** throw. Callers inspect the `ok` discriminant
 * and use the `message` field on failures.
 */
export function parseMemo(raw: string): MemoParseResult {
  // --- type guard ----------------------------------------------------------
  if (typeof raw !== "string") {
    return { ok: false, message: "Memo must be a string." };
  }

  // --- empty / too short ---------------------------------------------------
  if (raw.length === 0) {
    return { ok: false, message: "Memo must not be empty." };
  }

  if (raw.length < MIN_MEMO_LENGTH) {
    return { ok: false, message: "Memo is too short to contain a valid code." };
  }

  // --- prefix check --------------------------------------------------------
  if (!raw.startsWith(MP_PREFIX)) {
    return { ok: false, message: "Mergepay memo must start with 'MP:'." };
  }

  // --- byte length (Stellar MEMO_TEXT limit) -------------------------------
  if (Buffer.byteLength(raw, "utf8") > MAX_MEMO_BYTES) {
    return {
      ok: false,
      message: `Mergepay memo must be ${MAX_MEMO_BYTES} UTF-8 bytes or fewer to fit in a Stellar MEMO_TEXT.`,
    };
  }

  // --- extract & validate code ---------------------------------------------
  const code = raw.slice(MP_PREFIX.length);

  if (code.length === 0) {
    return { ok: false, message: "Memo code must not be empty after 'MP:' prefix." };
  }

  if (!VALID_CODE_RE.test(code)) {
    return {
      ok: false,
      message: "Memo code contains invalid characters. Only uppercase A-Z (excluding I, O) and 2-9 are allowed.",
    };
  }

  return { ok: true, code, memo: raw };
}

/**
 * Validate an expense memo strictly as a Stellar `MEMO_TEXT` value of the form
 * `MP:<code>`. This intentionally mirrors the canonical parser and fails fast
 * on missing prefixes, malformed code characters, or oversized memos.
 */
export function validateExpenseMemo(memo: string): boolean {
  return typeof memo === "string" && parseMemo(memo).ok;
}

/**
 * Parse an expense memo and return the extracted code or `null` when the memo
 * does not match the strict `MP:<code>` contract.
 */
export function parseExpenseCode(memo: string): string | null {
  const parsed = parseMemo(memo);
  return parsed.ok ? parsed.code : null;
}

// ---------------------------------------------------------------------------
// On-chain payment memo validation
// ---------------------------------------------------------------------------

/** Byte length of a Stellar MEMO_HASH / MEMO_RETURN payload. */
export const MEMO_HASH_BYTES = 32 as const;

/** Why an on-chain payment memo cannot be attributed to the expected reference. */
export type PaymentMemoFailureReason =
  /** No memo at all (`memo_type` absent or "none", or an empty text memo). */
  | "missing_memo"
  /** A memo type Mergepay never issues (`id`, `return`, or unknown). */
  | "unsupported_memo_type"
  /** A `hash` memo whose payload is not 32 bytes of canonical base64. */
  | "invalid_hash_memo"
  /** A well-formed `hash` memo — it cannot carry an `MP:` reference. */
  | "hash_memo_mismatch"
  /** A text memo that is not a well-formed `MP:<code>` reference. */
  | "malformed_memo"
  /** A well-formed `MP:<code>` memo that names a different code. */
  | "code_mismatch";

export type PaymentMemoValidation =
  | { ok: true; code: string; memo: string }
  | { ok: false; reason: PaymentMemoFailureReason; message: string };

/**
 * The memo fields of a transaction as Horizon reports them. For `text` memos
 * `memo` is the decoded string; for `hash` / `return` memos it is the 32-byte
 * payload in base64; for `id` memos it is the decimal id.
 */
export interface OnChainMemo {
  memoType?: string | null;
  memo?: string | null;
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isValidHashMemo(value: string): boolean {
  if (!BASE64_RE.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  // Round-trip check rejects non-canonical padding bits.
  return bytes.length === MEMO_HASH_BYTES && bytes.toString("base64") === value;
}

/**
 * Decide whether an incoming payment's on-chain memo is the Mergepay
 * reference `MP:<expectedCode>`, and if not, exactly why.
 *
 * Mergepay only ever issues `MEMO_TEXT` memos, so attribution is strict:
 *
 *  - the memo must be of type `text` — hash, id, and return memos are never
 *    attributed, even when a hash payload happens to contain `MP:` bytes;
 *  - the text must parse as `MP:<code>` via {@link parseMemo}, with no case
 *    folding, trimming, or other normalisation (normalising would let a
 *    near-miss memo be credited to someone else's settlement);
 *  - the parsed code must equal `expectedCode` exactly.
 *
 * Failure messages never echo the on-chain memo: it is attacker-controlled
 * input and the message is persisted as a settlement failure reason.
 *
 * Pure and synchronous — no Horizon or database I/O.
 *
 * @param onChain - The transaction's `memo_type` / `memo` as read from Horizon.
 * @param expectedCode - The settlement short code the payment must reference.
 */
export function validatePaymentMemo(
  onChain: OnChainMemo,
  expectedCode: string
): PaymentMemoValidation {
  const memoType = onChain.memoType ?? "none";
  const memo = onChain.memo ?? "";

  if (memoType === "none") {
    return { ok: false, reason: "missing_memo", message: "Transaction has no memo" };
  }

  if (memoType === "hash") {
    const prefix = `Unexpected memo type: expected "text", got "hash"`;
    if (!isValidHashMemo(memo)) {
      return {
        ok: false,
        reason: "invalid_hash_memo",
        message: `${prefix}; the hash memo is malformed (expected ${MEMO_HASH_BYTES} bytes, base64-encoded)`,
      };
    }
    return {
      ok: false,
      reason: "hash_memo_mismatch",
      message: `${prefix}; a hash memo cannot carry the MP: settlement reference`,
    };
  }

  if (memoType !== "text") {
    return {
      ok: false,
      reason: "unsupported_memo_type",
      message: `Unexpected memo type: expected "text", got "${memoType.slice(0, 16)}"`,
    };
  }

  if (memo.length === 0) {
    return { ok: false, reason: "missing_memo", message: "Transaction has no memo" };
  }

  const parsed = parseMemo(memo);
  if (!parsed.ok) {
    return {
      ok: false,
      reason: "malformed_memo",
      message: `Transaction memo is not a valid Mergepay reference: ${parsed.message}`,
    };
  }

  if (parsed.code !== expectedCode) {
    return {
      ok: false,
      reason: "code_mismatch",
      message: "Transaction memo does not match the expected settlement reference",
    };
  }

  return { ok: true, code: parsed.code, memo: parsed.memo };
}
