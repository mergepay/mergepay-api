import { describe, it, expect } from "vitest";

import {
  parseMemo,
  isValidMemoCode,
  isValidCodeChar,
  MP_PREFIX,
  MAX_MEMO_BYTES,
} from "../src/lib/memo";
import { ALPHABET } from "../src/services/codes";

// A 10-char code using only approved characters (no I, O, 0, 1).
const VALID_CODE = "ABCDEFGHJK";
const VALID_MEMO = `MP:${VALID_CODE}`;

// ─── isValidCodeChar ────────────────────────────────────────────────────────

describe("isValidCodeChar", () => {
  it.each([...ALPHABET])("accepts '%s' from the approved alphabet", (ch) => {
    expect(isValidCodeChar(ch)).toBe(true);
  });

  it.each(["I", "O", "0", "1"])("rejects '%s' (ambiguous character)", (ch) => {
    expect(isValidCodeChar(ch)).toBe(false);
  });

  it.each(["a", "z", "!", " ", "-", "@"])("rejects '%s' (non-alphabet character)", (ch) => {
    expect(isValidCodeChar(ch)).toBe(false);
  });
});

// ─── isValidMemoCode ────────────────────────────────────────────────────────

describe("isValidMemoCode", () => {
  it("accepts a valid 10-char code", () => {
    expect(isValidMemoCode(VALID_CODE)).toBe(true);
  });

  it("accepts a single valid character", () => {
    expect(isValidMemoCode("A")).toBe(true);
  });

  it("accepts the full ALPHABET as a code", () => {
    expect(isValidMemoCode(ALPHABET)).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidMemoCode("")).toBe(false);
  });

  it("rejects a code containing 'I'", () => {
    expect(isValidMemoCode("ABCDEFGHJI")).toBe(false);
  });

  it("rejects a code containing 'O'", () => {
    expect(isValidMemoCode("ABCDEFGHJKO")).toBe(false);
  });

  it("rejects a code containing '0'", () => {
    expect(isValidMemoCode("ABCDEFGHJ0")).toBe(false);
  });

  it("rejects a code containing '1'", () => {
    expect(isValidMemoCode("ABCDEFGHJ1")).toBe(false);
  });

  it("rejects lowercase characters", () => {
    expect(isValidMemoCode("abcdefghjk")).toBe(false);
  });

  it("rejects special characters", () => {
    expect(isValidMemoCode("ABC-DEF@GH")).toBe(false);
  });
});

// ─── parseMemo ──────────────────────────────────────────────────────────────

describe("parseMemo", () => {
  // --- happy path -----------------------------------------------------------

  describe("valid memos", () => {
    it("parses a standard 10-char memo", () => {
      const result = parseMemo(VALID_MEMO);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(VALID_CODE);
        expect(result.memo).toBe(VALID_MEMO);
      }
    });

    it("parses a short code (1 char)", () => {
      const result = parseMemo("MP:A");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("A");
      }
    });

    it("parses a code using all allowed character types", () => {
      // A code mixing letters (no I/O) and digits (no 0/1).
      const code = "ABCDEFGHJK23456789";
      const result = parseMemo(`MP:${code}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(code);
      }
    });

    it("parses a code that is exactly 28 bytes", () => {
      // 28 bytes = 3 ("MP:") + 25 code chars
      const code = "A".repeat(25);
      const result = parseMemo(`MP:${code}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(code);
        expect(Buffer.byteLength(result.memo, "utf8")).toBe(28);
      }
    });
  });

  // --- prefix errors --------------------------------------------------------

  describe("missing or wrong prefix", () => {
    it("rejects a memo without the MP: prefix", () => {
      const result = parseMemo(VALID_CODE);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("MP:");
      }
    });

    it("rejects a memo with a lowercase prefix", () => {
      const result = parseMemo("mp:ABCDEFGHJK");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("MP:");
      }
    });

    it("rejects a memo with only 'MP' and no colon", () => {
      const result = parseMemo("MPABCDEFGHJK");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("MP:");
      }
    });
  });

  // --- length / size errors -------------------------------------------------

  describe("length constraints", () => {
    it("rejects an empty string", () => {
      const result = parseMemo("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("empty");
      }
    });

    it("rejects 'MP:' with no code", () => {
      const result = parseMemo("MP:");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("too short");
      }
    });

    it("rejects a memo exceeding 28 bytes", () => {
      // 3 ("MP:") + 26 code chars = 29 bytes
      const code = "A".repeat(26);
      const result = parseMemo(`MP:${code}`);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("28");
      }
    });

    it("rejects a memo that is too short to be valid", () => {
      const result = parseMemo("M");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("too short");
      }
    });
  });

  // --- code character errors ------------------------------------------------

  describe("invalid code characters", () => {
    it("rejects a code containing the letter I", () => {
      const result = parseMemo("MP:ABCDEFGHI");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });

    it("rejects a code containing the letter O", () => {
      const result = parseMemo("MP:ABCDEFGHJKO");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });

    it("rejects a code containing the digit 0", () => {
      const result = parseMemo("MP:ABCDEFGHJ0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });

    it("rejects a code containing the digit 1", () => {
      const result = parseMemo("MP:ABCDEFGHJ1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });

    it("rejects lowercase letters in the code", () => {
      const result = parseMemo("MP:abcdefghjk");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });

    it("rejects a code with spaces", () => {
      const result = parseMemo("MP:ABC DEF GH");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });

    it("rejects a code with special characters", () => {
      const result = parseMemo("MP:ABC-DEF@GH");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("invalid characters");
      }
    });
  });

  // --- type safety ----------------------------------------------------------

  describe("type guard", () => {
    it("rejects non-string input", () => {
      const result = parseMemo(123 as any);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toContain("string");
      }
    });

    it("rejects null", () => {
      const result = parseMemo(null as any);
      expect(result.ok).toBe(false);
    });
  });

  // --- constants are correct ------------------------------------------------

  describe("constants", () => {
    it("MP_PREFIX is 'MP:'", () => {
      expect(MP_PREFIX).toBe("MP:");
    });

    it("MAX_MEMO_BYTES is 28", () => {
      expect(MAX_MEMO_BYTES).toBe(28);
    });
  });
});
