/**
 * The memo formatting utilities — generating, parsing and validating the
 * `MP:<code>` expense memo against Stellar's 28-byte MEMO_TEXT limit.
 *
 * Three implementations must agree, or an on-chain payment can never be
 * reconciled back to the record it pays off:
 *
 *   - `memoText` — src/services/stellar.ts. The formatter the payment routes
 *     (settlements, treasury) stamp on outgoing transactions. It is the only
 *     helper that *truncates* an oversized code; it enforces length alone.
 *   - `buildMemo` / `buildMemoOrThrow` / `generateMemo` —
 *     src/services/memo.ts. The strict builder: it refuses an oversized or
 *     malformed code instead of truncating, and generates fresh settlement
 *     codes.
 *   - `parseMemo` / `validateExpenseMemo` / `parseExpenseCode` —
 *     src/lib/memo.ts (re-exported from src/utils/memo.ts), plus the Zod
 *     `mpMemoSchema` that guards request bodies — what reconciliation uses to
 *     read a memo back.
 *
 * `tests/memo.test.ts`, `tests/memo-format.test.ts` and
 * `tests/services/memo.test.ts` cover each helper in isolation. This file
 * pins how they behave *together*: prefix formatting, valid expense codes,
 * and the two deliberately different oversized-input policies (truncate vs.
 * reject) against the 28-byte boundary.
 *
 * Note on `memoText`: it truncates by character count, which is identical to
 * byte count for the ASCII short-code alphabet every real code comes from
 * (`src/services/codes.ts`). The byte-vs-character distinction is therefore
 * only asserted where it is load-bearing — on the parser, which must count
 * UTF-8 bytes for attacker-supplied memos.
 */
import { describe, it, expect, vi } from "vitest";

// src/services/memo.ts pulls the Prisma client in through src/db.ts. The
// generation helpers are pure, so mock the module rather than instantiate a
// database client to reach them.
vi.mock("../src/db", () => ({
  prisma: { expense: { findFirst: vi.fn() }, expenseShare: { count: vi.fn() } },
}));

import { memoText } from "../src/services/stellar";
import { buildMemo, buildMemoOrThrow, generateMemo } from "../src/services/memo";
import {
  MP_PREFIX,
  MAX_MEMO_BYTES,
  parseMemo,
  validateExpenseMemo,
  parseExpenseCode,
  isValidMemoCode,
  isValidCodeChar,
} from "../src/lib/memo";
import { mpMemoSchema } from "../src/lib/stellar-validation";
import { ALPHABET, shortCode } from "../src/services/codes";

/** Stellar's MEMO_TEXT ceiling in bytes — the limit every helper serves. */
const MAX_CODE_LENGTH = MAX_MEMO_BYTES - MP_PREFIX.length; // 25

/** A valid code of exactly `length`, built from the approved alphabet. */
function codeFor(length: number): string {
  return ALPHABET.repeat(Math.ceil(length / ALPHABET.length)).slice(0, length);
}

describe("memo formatting — constants", () => {
  it("pins the Mergepay prefix and the Stellar MEMO_TEXT limit", () => {
    expect(MP_PREFIX).toBe("MP:");
    // Stellar memos are capped at 28 bytes; the parser and builder both
    // enforce this, so a change here would silently change both.
    expect(MAX_MEMO_BYTES).toBe(28);
    // "MP:" (3 bytes) + 25 code characters = exactly 28 bytes.
    expect(MAX_CODE_LENGTH).toBe(25);
  });
});

describe("memo formatting — prefix formatting", () => {
  it("stamps the MP: prefix on every code the formatter is given", () => {
    expect(memoText("ABC123")).toBe("MP:ABC123");
    expect(memoText("A")).toBe("MP:A");
    expect(memoText(codeFor(MAX_CODE_LENGTH))).toBe(`MP:${codeFor(MAX_CODE_LENGTH)}`);
  });

  it("builds exactly MP_PREFIX + code and never anything else", () => {
    for (const code of ["A", "AB234", "EXPENSE42", codeFor(MAX_CODE_LENGTH)]) {
      const built = buildMemo(code);
      expect(built.ok).toBe(true);
      if (built.ok) {
        expect(built.memo).toBe(`${MP_PREFIX}${code}`);
        expect(built.memo.startsWith(MP_PREFIX)).toBe(true);
        expect(built.code).toBe(code);
      }
    }
  });

  it("agrees with the truncating formatter for every valid code length (1-25)", () => {
    // Within the limit the strict builder and the payment formatter must
    // produce byte-identical memos, or a payment built with one could never
    // be parsed back by the other.
    for (let length = 1; length <= MAX_CODE_LENGTH; length++) {
      const code = codeFor(length);
      const built = buildMemo(code);
      expect(built.ok).toBe(true);
      if (!built.ok) continue;

      const formatted = memoText(code);
      expect(formatted).toBe(built.memo);
      expect(Buffer.byteLength(formatted, "utf8")).toBeLessThanOrEqual(MAX_MEMO_BYTES);
      expect(parseMemo(formatted).ok).toBe(true);
    }
  });

  it("leaves the formatter free to run, but reserves validation for the parser", () => {
    // `memoText` enforces length only — it is a formatter, not a validator.
    // Callers pass codes from shortCode(); anything malformed that reaches it
    // is caught downstream by buildMemo/parseMemo.
    expect(memoText("bad code")).toBe("MP:bad code");
    expect(memoText("")).toBe("MP:");
    expect(buildMemo("bad code").ok).toBe(false);
    expect(parseMemo("MP:bad code").ok).toBe(false);
  });
});

describe("memo formatting — valid expense codes", () => {
  it("formats, parses and validates memos for generated expense codes", () => {
    // Expense routes default the memo code to shortCode().slice(0, 8)
    // (src/routes/expenses.ts), so those are the codes that reach the ledger.
    for (let i = 0; i < 100; i++) {
      const code = shortCode().slice(0, 8);
      expect(code).toHaveLength(8);
      expect(isValidMemoCode(code)).toBe(true);

      const memo = memoText(code);
      expect(memo).toBe(`${MP_PREFIX}${code}`);

      const parsed = parseMemo(memo);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.code).toBe(code);

      expect(buildMemo(code).ok).toBe(true);
      expect(validateExpenseMemo(memo)).toBe(true);
      expect(parseExpenseCode(memo)).toBe(code);
      expect(mpMemoSchema.safeParse(memo).success).toBe(true);
    }
  });

  it("round-trips freshly generated settlement memos through every surface", () => {
    for (let i = 0; i < 25; i++) {
      const memo = generateMemo();
      expect(memo.startsWith(MP_PREFIX)).toBe(true);
      // "MP:" + the 10-char short code — comfortably inside the limit.
      expect(Buffer.byteLength(memo, "utf8")).toBe(MP_PREFIX.length + 10);

      const parsed = parseMemo(memo);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.code).toHaveLength(10);
        // The formatter and the builder reproduce the generated memo exactly.
        expect(memoText(parsed.code)).toBe(memo);
        expect(buildMemoOrThrow(parsed.code)).toBe(memo);
      }

      expect(validateExpenseMemo(memo)).toBe(true);
      expect(mpMemoSchema.safeParse(memo).success).toBe(true);
    }
  });

  it("accepts every character of the short-code alphabet and nothing ambiguous", () => {
    for (const ch of ALPHABET) {
      expect(isValidCodeChar(ch)).toBe(true);
      expect(isValidMemoCode(ch)).toBe(true);
      expect(validateExpenseMemo(`${MP_PREFIX}${ch}`)).toBe(true);
    }
    // The characters excluded from ALPHABET: I, O, 0, 1 (and lowercase).
    for (const ch of ["I", "O", "0", "1", "a", "z"]) {
      expect(isValidCodeChar(ch)).toBe(false);
      expect(isValidMemoCode(ch)).toBe(false);
      expect(validateExpenseMemo(`${MP_PREFIX}${ch}`)).toBe(false);
    }
  });
});

describe("memo formatting — oversized strings", () => {
  it("truncates to the 28-byte ceiling but keeps the MP: prefix", () => {
    const memo = memoText("A".repeat(60));
    expect(memo).toBe(`${MP_PREFIX}${"A".repeat(MAX_CODE_LENGTH)}`);
    expect(memo).toHaveLength(MAX_MEMO_BYTES);
    expect(Buffer.byteLength(memo, "utf8")).toBe(MAX_MEMO_BYTES);
    expect(memo.startsWith(MP_PREFIX)).toBe(true);
  });

  it("truncates only at the boundary — a 25-char code passes through untouched", () => {
    expect(memoText(codeFor(MAX_CODE_LENGTH))).toBe(`${MP_PREFIX}${codeFor(MAX_CODE_LENGTH)}`);
    // One character over the ceiling is cut back to exactly 25 code characters.
    expect(memoText(codeFor(MAX_CODE_LENGTH + 1))).toBe(
      `${MP_PREFIX}${codeFor(MAX_CODE_LENGTH)}`
    );
  });

  it("keeps truncated output parseable for alphabet codes", () => {
    const parsed = parseMemo(memoText("ABCDEFGHJK23456789ABCDEFGHJK"));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.code).toHaveLength(MAX_CODE_LENGTH);
      expect(validateExpenseMemo(memoText("ABCDEFGHJK23456789ABCDEFGHJK"))).toBe(true);
    }
  });

  it("rejects an oversized code instead of truncating it", () => {
    // The deliberate contrast with memoText: where a bad code is a
    // programming error, the builder reports it rather than silently
    // shortening the reference a payment will be reconciled by.
    const built = buildMemo(codeFor(MAX_CODE_LENGTH + 1));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.message).toMatch(/28 UTF-8 bytes or fewer/);
  });

  it("throws from the *OrThrow variants when the code cannot become a memo", () => {
    expect(() => buildMemoOrThrow(codeFor(MAX_CODE_LENGTH + 1))).toThrow(
      /28 UTF-8 bytes or fewer/
    );
    expect(() => generateMemo(codeFor(MAX_CODE_LENGTH + 1))).toThrow(
      /28 UTF-8 bytes or fewer/
    );
    expect(() => buildMemoOrThrow("")).toThrow(/must not be empty/);
  });

  it("draws the line at exactly 28 bytes across every validation surface", () => {
    const atLimit = `${MP_PREFIX}${codeFor(MAX_CODE_LENGTH)}`; // 28 bytes
    const overLimit = `${MP_PREFIX}${codeFor(MAX_CODE_LENGTH + 1)}`; // 29 bytes
    expect(Buffer.byteLength(atLimit, "utf8")).toBe(MAX_MEMO_BYTES);
    expect(Buffer.byteLength(overLimit, "utf8")).toBe(MAX_MEMO_BYTES + 1);

    expect(parseMemo(atLimit).ok).toBe(true);
    expect(validateExpenseMemo(atLimit)).toBe(true);
    expect(parseExpenseCode(atLimit)).not.toBeNull();
    expect(mpMemoSchema.safeParse(atLimit).success).toBe(true);

    const rejected = parseMemo(overLimit);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.message).toMatch(/28 UTF-8 bytes or fewer/);
    expect(validateExpenseMemo(overLimit)).toBe(false);
    expect(parseExpenseCode(overLimit)).toBeNull();
    expect(mpMemoSchema.safeParse(overLimit).success).toBe(false);
  });

  it("counts UTF-8 bytes, not characters, when checking the limit", () => {
    // 13 × 'é' (2 bytes each) = 26 bytes + "MP:" = 29 bytes — while the
    // string is only 16 characters long. Character-counting would accept it
    // and Horizon would reject the transaction.
    const memo = `${MP_PREFIX}${"é".repeat(13)}`;
    expect(memo.length).toBeLessThan(MAX_MEMO_BYTES);
    expect(Buffer.byteLength(memo, "utf8")).toBe(MAX_MEMO_BYTES + 1);

    const parsed = parseMemo(memo);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/28 UTF-8 bytes or fewer/);
    expect(validateExpenseMemo(memo)).toBe(false);
    expect(mpMemoSchema.safeParse(memo).success).toBe(false);
  });
});

describe("memo formatting — validation surfaces agree", () => {
  const memos = [
    "MP:ABC234",
    "MP:A",
    `MP:${codeFor(MAX_CODE_LENGTH)}`,
    "MP:",
    "MP:ab123",
    "MP:AB 123",
    "mp:ABC234",
    "ABC234",
    "",
    `MP:${codeFor(MAX_CODE_LENGTH + 1)}`,
  ];

  it("validateExpenseMemo accepts exactly what parseMemo accepts", () => {
    for (const memo of memos) {
      expect(validateExpenseMemo(memo)).toBe(parseMemo(memo).ok);
    }
  });

  it("parseExpenseCode returns the parsed code, or null on any rejection", () => {
    for (const memo of memos) {
      const parsed = parseMemo(memo);
      expect(parseExpenseCode(memo)).toBe(parsed.ok ? parsed.code : null);
    }
  });

  it("mpMemoSchema guards the prefix and size; the alphabet is the parser's job", () => {
    // The Zod schema is deliberately laxer: routes validate shape early, and
    // the parser enforces the character alphabet. Documenting the split keeps
    // a future refactor from assuming they are interchangeable.
    expect(mpMemoSchema.safeParse("MP:lowercase").success).toBe(true);
    expect(validateExpenseMemo("MP:lowercase")).toBe(false);

    expect(mpMemoSchema.safeParse("ABC234").success).toBe(false);
    expect(mpMemoSchema.safeParse(`MP:${codeFor(MAX_CODE_LENGTH + 1)}`).success).toBe(false);
  });
});
