import { describe, it, expect } from "vitest";
import {
  parseMemo,
  isValidMemoCode,
  isValidCodeChar,
  MP_PREFIX,
  MAX_MEMO_BYTES,
  validateExpenseMemo,
  parseExpenseCode,
} from "../memo";

describe("Stellar Memo Validation Utility (src/utils/memo)", () => {
  describe("Valid Memos", () => {
    it("accepts canonical memo format with approved characters (e.g. MP:AB234, MP:ABC9)", () => {
      const result = parseMemo("MP:AB234");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("AB234");
        expect(result.memo).toBe("MP:AB234");
      }
    });

    it("accepts valid alphanumeric code using approved alphabet characters", () => {
      const result = parseMemo("MP:XYZ234789");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("XYZ234789");
      }
    });

    it("accepts single-character code after prefix", () => {
      const result = parseMemo("MP:A");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe("A");
      }
    });

    it("accepts memo at maximum Stellar MEMO_TEXT byte length (28 bytes)", () => {
      // "MP:" is 3 bytes + 25 valid code chars = 28 bytes
      const code = "A".repeat(25);
      const memo = `${MP_PREFIX}${code}`;
      expect(Buffer.byteLength(memo, "utf8")).toBe(MAX_MEMO_BYTES);
      const result = parseMemo(memo);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.code).toBe(code);
      }
    });
  });

  describe("Invalid Memos", () => {
    it("rejects empty string", () => {
      const result = parseMemo("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/must not be empty/i);
      }
    });

    it("rejects memo missing MP: prefix", () => {
      const testCases = ["AB123", "MERGEPAY:AB123", "mp:AB123", "PREFIX:123", "HELLO"];
      for (const memo of testCases) {
        const result = parseMemo(memo);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toMatch(/must start with 'MP:'/i);
        }
      }
    });

    it("rejects lowercase letters in memo code", () => {
      const testCases = ["MP:ab123", "MP:abc", "MP:Ab123", "MP:testCode"];
      for (const memo of testCases) {
        const result = parseMemo(memo);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toMatch(/invalid characters/i);
        }
      }
    });

    it("rejects special characters in memo code", () => {
      const testCases = [
        "MP:AB-123",
        "MP:AB_123",
        "MP:AB.123",
        "MP:AB 123",
        "MP:AB$123",
        "MP:AB#123",
        "MP:AB@123",
        "MP:AB!123",
      ];
      for (const memo of testCases) {
        const result = parseMemo(memo);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toMatch(/invalid characters/i);
        }
      }
    });

    it("rejects ambiguous characters excluded from alphabet (I, O, 0, 1)", () => {
      const ambiguousCases = ["MP:ABI", "MP:ABO", "MP:AB0", "MP:AB1"];
      for (const memo of ambiguousCases) {
        const result = parseMemo(memo);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.message).toMatch(/invalid characters/i);
        }
      }
    });

    it("rejects memo with empty code after prefix", () => {
      const result = parseMemo("MP:");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/too short|must not be empty/i);
      }
    });

    it("rejects memo exceeding 28 bytes", () => {
      const longCode = "A".repeat(26);
      const longMemo = `${MP_PREFIX}${longCode}`; // 29 bytes
      const result = parseMemo(longMemo);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).toMatch(/28 UTF-8 bytes or fewer/i);
      }
    });

    it("rejects non-string inputs safely without throwing", () => {
      // @ts-expect-error test runtime boundary
      expect(parseMemo(null).ok).toBe(false);
      // @ts-expect-error test runtime boundary
      expect(parseMemo(undefined).ok).toBe(false);
      // @ts-expect-error test runtime boundary
      expect(parseMemo(12345).ok).toBe(false);
    });
  });

  describe("Helper Functions", () => {
    it("isValidMemoCode returns true for valid code and false for invalid", () => {
      expect(isValidMemoCode("AB234")).toBe(true);
      expect(isValidMemoCode("")).toBe(false);
      expect(isValidMemoCode("ab123")).toBe(false);
      expect(isValidMemoCode("AB!123")).toBe(false);
      expect(isValidMemoCode("AB123")).toBe(false); // 1 is ambiguous character
    });

    it("isValidCodeChar validates individual character", () => {
      expect(isValidCodeChar("A")).toBe(true);
      expect(isValidCodeChar("9")).toBe(true);
      expect(isValidCodeChar("a")).toBe(false);
      expect(isValidCodeChar("0")).toBe(false);
      expect(isValidCodeChar("I")).toBe(false);
      expect(isValidCodeChar("O")).toBe(false);
    });

    it("validates expense memos with the canonical MP: prefix and code rules", () => {
      expect(validateExpenseMemo("MP:AB234")).toBe(true);
      expect(validateExpenseMemo("MP:XYZ234789")).toBe(true);
      expect(validateExpenseMemo("MP:A")).toBe(true);
      expect(validateExpenseMemo("AB234")).toBe(false);
      expect(validateExpenseMemo("mp:AB234")).toBe(false);
      expect(validateExpenseMemo("MP:ab123")).toBe(false);
    });

    it("parses expense codes from valid memos and returns null for invalid ones", () => {
      expect(parseExpenseCode("MP:AB234")).toBe("AB234");
      expect(parseExpenseCode("MP:XYZ234789")).toBe("XYZ234789");
      expect(parseExpenseCode("MP:")).toBeNull();
      expect(parseExpenseCode("AB234")).toBeNull();
      expect(parseExpenseCode("mp:AB234")).toBeNull();
      expect(parseExpenseCode("MP:AB!234")).toBeNull();
      expect(parseExpenseCode("MP:" + "A".repeat(26))).toBeNull();
    });
  });
});
