/**
 * The `MP:` memo format contract.
 *
 * Mergepay links on-chain Stellar payments to internal records by memo alone
 * (`MP:<shortCode>` — see `settlement-reconciliation.ts` and
 * `treasury-proposals.ts`). If the code that *builds* a memo and the code that
 * *parses* one ever disagree, reconciliation silently fails: a payment lands
 * but no expense or settlement can be matched to it.
 *
 * `tests/memo.test.ts` covers the parser/validator in detail. This file pins
 * the complementary half — the format itself — and the round trip between the
 * two:
 *
 *   - a memo is exactly `MP_PREFIX + code`;
 *   - any code the `shortCode()` generator can produce must parse back;
 *   - the 28-byte MEMO_TEXT ceiling is enforced at the boundary;
 *   - the `src/utils/memo` re-export and `src/lib/memo` are the same functions.
 */
import { describe, it, expect } from "vitest";

// Import through the public utils path so the re-export is exercised too.
import {
  parseMemo,
  isValidMemoCode,
  isValidCodeChar,
  MP_PREFIX,
  MAX_MEMO_BYTES,
} from "../src/utils/memo";
import * as libMemo from "../src/lib/memo";
import { shortCode, ALPHABET } from "../src/services/codes";

/** Build a memo the way every reconciliation path does. */
const formatMemo = (code: string): string => `${MP_PREFIX}${code}`;

const MAX_CODE_LENGTH = MAX_MEMO_BYTES - MP_PREFIX.length; // 25

describe("MP: format — constructing memos", () => {
  it("builds MP_PREFIX + code and parses it back unchanged", () => {
    const code = "EXPENSE42";
    const memo = formatMemo(code);
    expect(memo).toBe("MP:EXPENSE42");

    const result = parseMemo(memo);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.code).toBe(code);
      expect(result.memo).toBe(memo);
    }
  });

  it("round-trips a single-character code for every allowed alphabet character", () => {
    for (const ch of ALPHABET) {
      const result = parseMemo(formatMemo(ch));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(ch);
        // Re-formatting the parsed code reproduces the original memo exactly.
        expect(formatMemo(result.code)).toBe(result.memo);
      }
    }
  });

  it("round-trips every allowed code length from 1 to the 25-char maximum", () => {
    for (let length = 1; length <= MAX_CODE_LENGTH; length++) {
      const code = "A".repeat(length);
      const memo = formatMemo(code);
      expect(Buffer.byteLength(memo, "utf8")).toBeLessThanOrEqual(MAX_MEMO_BYTES);

      const result = parseMemo(memo);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(code);
        expect(formatMemo(result.code)).toBe(memo);
      }
    }
  });

  it("formats the maximum-length code at exactly 28 bytes", () => {
    const memo = formatMemo("A".repeat(MAX_CODE_LENGTH));
    expect(Buffer.byteLength(memo, "utf8")).toBe(MAX_MEMO_BYTES);
    expect(parseMemo(memo).ok).toBe(true);
  });

  it("is idempotent — parsing and re-formatting never drifts the value", () => {
    const memo = formatMemo("ABCDEFGHJK");
    const first = parseMemo(memo);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = parseMemo(formatMemo(first.code));
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.code).toBe(first.code);
      expect(second.memo).toBe(first.memo);
    }
  });
});

describe("MP: format — generated short codes are always valid memos", () => {
  it("produces a parseable MP:<shortCode> memo for many generated codes", () => {
    for (let i = 0; i < 250; i++) {
      const code = shortCode();
      expect(code).toHaveLength(10);
      expect(isValidMemoCode(code)).toBe(true);

      const result = parseMemo(formatMemo(code));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(code);
      }
    }
  });

  it("keeps MP:<shortCode> well inside the 28-byte limit", () => {
    const memo = formatMemo(shortCode());
    expect(Buffer.byteLength(memo, "utf8")).toBe(MP_PREFIX.length + 10);
    expect(Buffer.byteLength(memo, "utf8")).toBeLessThan(MAX_MEMO_BYTES);
  });

  it("matches the memo shape used by settlement reconciliation", () => {
    // Settlement reconciliation derives the expected memo as `MP:${shortCode}`;
    // the parser must accept exactly that string.
    const settlement = { shortCode: "ABC234" };
    const expectedMemo = `${MP_PREFIX}${settlement.shortCode}`;
    const result = parseMemo(expectedMemo);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.code).toBe(settlement.shortCode);
  });

  it("accepts representative expense and settlement codes", () => {
    const codes = ["ABCDEFGHJK", "EXP2345", "XYZ234789", "AB234", "ZZ9", "A"];
    for (const code of codes) {
      const result = parseMemo(formatMemo(code));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.code).toBe(code);
    }
  });
});

describe("MP: format — invalid prefixes", () => {
  it("rejects memos that do not start with the exact MP: prefix", () => {
    const cases = ["AB123", "MERGEPAY:AB123", "mp:AB123", "PREFIX:123", "HELLO"];
    for (const memo of cases) {
      const result = parseMemo(memo);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("MP:");
    }
  });

  it("is case-sensitive and requires the colon", () => {
    expect(parseMemo("mp:ABCDEFGHJK").ok).toBe(false);
    expect(parseMemo("Mp:ABCDEFGHJK").ok).toBe(false);
    expect(parseMemo("MPABCDEFGHJK").ok).toBe(false);
  });

  it("rejects a prefix that only appears mid-string", () => {
    const result = parseMemo("XXMP:ABCDEFGHJK");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("MP:");
  });

  it("rejects leading whitespace before the prefix", () => {
    const result = parseMemo(" MP:ABCDEFGHJK");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("MP:");
  });

  it("rejects a doubled colon after the prefix", () => {
    const result = parseMemo("MP::ABCDEFGHJK");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/invalid characters/i);
  });
});

describe("MP: format — length constraints", () => {
  it("rejects an empty string", () => {
    const result = parseMemo("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("empty");
  });

  it("rejects strings too short to carry a code", () => {
    for (const memo of ["M", "MP"]) {
      const result = parseMemo(memo);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("too short");
    }
  });

  it("rejects a prefix with no code", () => {
    const result = parseMemo("MP:");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("too short");
  });

  it("rejects a code one byte over the 28-byte limit", () => {
    const memo = formatMemo("A".repeat(MAX_CODE_LENGTH + 1)); // 29 bytes
    expect(Buffer.byteLength(memo, "utf8")).toBe(MAX_MEMO_BYTES + 1);
    const result = parseMemo(memo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("28");
  });

  it("enforces byte length before character validity", () => {
    // 13 multi-byte characters ('é' = 2 bytes) push the memo to 29 bytes while
    // also containing invalid code characters. The byte-limit message wins, so
    // a too-long memo is rejected for its length even before char validation.
    const memo = formatMemo("é".repeat(13));
    expect(Buffer.byteLength(memo, "utf8")).toBeGreaterThan(MAX_MEMO_BYTES);
    const result = parseMemo(memo);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("28");
  });
});

describe("MP: format — src/utils/memo re-export parity", () => {
  it("re-exports the same function identities as src/lib/memo", () => {
    expect(parseMemo).toBe(libMemo.parseMemo);
    expect(isValidMemoCode).toBe(libMemo.isValidMemoCode);
    expect(isValidCodeChar).toBe(libMemo.isValidCodeChar);
  });

  it("re-exports the same constants as src/lib/memo", () => {
    expect(MP_PREFIX).toBe(libMemo.MP_PREFIX);
    expect(MAX_MEMO_BYTES).toBe(libMemo.MAX_MEMO_BYTES);
  });

  it("agrees with the underlying implementation for every alphabet char", () => {
    for (const ch of ALPHABET) {
      expect(isValidCodeChar(ch)).toBe(libMemo.isValidCodeChar(ch));
      expect(isValidMemoCode(ch)).toBe(libMemo.isValidMemoCode(ch));
    }
  });
});
