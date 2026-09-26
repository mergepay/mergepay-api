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
