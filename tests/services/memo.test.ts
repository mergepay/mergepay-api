/**
 * Unit tests for the `MP:<code>` transaction memo helpers in
 * `src/services/memo.ts`: generation, parsing (valid memos, missing
 * prefixes, unexpected string formats), and the worker-facing validation
 * that resolves a parsed memo code to an active expense record.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: {
    expense: { findFirst: vi.fn() },
    expenseShare: { count: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  MP_PREFIX,
  MAX_MEMO_BYTES,
  buildMemo,
  buildMemoOrThrow,
  generateMemo,
  parseMemo,
  validateMemoAgainstActiveExpense,
} from "../../src/services/memo";
import { ALPHABET } from "../../src/services/codes";

describe("buildMemo — generate MP:<code> memos", () => {
  it("builds a memo from a valid code", () => {
    expect(buildMemo("ABC234")).toEqual({
      ok: true,
      memo: "MP:ABC234",
      code: "ABC234",
    });
  });

  it("uses the MP: prefix and never returns a code in the memo field", () => {
    const built = buildMemo("SETTLE23");
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.memo.startsWith(MP_PREFIX)).toBe(true);
    expect(built.memo).toBe(`${MP_PREFIX}SETTLE23`);
  });

  it("round-trips through parseMemo", () => {
    for (const code of ["A", "AB", "ABC234", "23456789ABCD"]) {
      const built = buildMemo(code);
      expect(built.ok).toBe(true);
      if (!built.ok) continue;

      const parsed = parseMemo(built.memo);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.code).toBe(code);
    }
  });

  it("rejects an empty code", () => {
    expect(buildMemo("")).toEqual({
      ok: false,
      message: "Memo code must not be empty.",
    });
  });

  it.each(["abc123", "ABC IO", "ABC/123", "AB01", "ABCDIO", "MP:ABC234"])(
    "rejects %s — characters outside the approved alphabet",
    (code) => {
      const built = buildMemo(code);
      expect(built.ok).toBe(false);
      if (built.ok) return;
      expect(built.message).toMatch(/invalid characters/);
    }
  );

  it("rejects a code that would push the memo past the 28-byte limit", () => {
    const built = buildMemo("A".repeat(MAX_MEMO_BYTES)); // 3 + 28 bytes
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.message).toMatch(/28 UTF-8 bytes/);
  });

  it("accepts a code at the exact 28-byte boundary", () => {
    const built = buildMemo("A".repeat(MAX_MEMO_BYTES - MP_PREFIX.length));
    expect(built.ok).toBe(true);
    if (built.ok) expect(Buffer.byteLength(built.memo, "utf8")).toBe(MAX_MEMO_BYTES);
  });

  it("rejects non-string input instead of throwing", () => {
    const built = buildMemo(undefined as unknown as string);
    expect(built).toEqual({ ok: false, message: "Memo code must be a string." });
  });
});

describe("buildMemoOrThrow / generateMemo", () => {
  it("returns the memo for a valid code", () => {
    expect(buildMemoOrThrow("ABC234")).toBe("MP:ABC234");
  });

  it("throws for an invalid code", () => {
    expect(() => buildMemoOrThrow("bad code")).toThrow(/invalid characters/);
  });

  it("generates a fresh settlement memo when no code is supplied", () => {
    const memo = generateMemo();
    expect(memo).toMatch(new RegExp(`^${MP_PREFIX}[${ALPHABET}]{10}$`));

    const parsed = parseMemo(memo);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.code).toHaveLength(10);
  });

  it("generates a memo for an explicit code", () => {
    expect(generateMemo("SETTLE23")).toBe("MP:SETTLE23");
  });

  it("throws when the explicit code cannot become a memo", () => {
    expect(() => generateMemo("")).toThrow(/must not be empty/);
  });

  it("generates distinct memos on successive calls", () => {
    expect(generateMemo()).not.toBe(generateMemo());
  });
});

describe("parseMemo — valid memos, missing prefixes, unexpected formats", () => {
  it.each(["MP:ABC234", "MP:A", "MP:ABCDEF2345", "MP:23456789AB"])(
    "parses the valid memo %s",
    (memo) => {
      const parsed = parseMemo(memo);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.code).toBe(memo.slice(MP_PREFIX.length));
        expect(parsed.memo).toBe(memo);
      }
    }
  );

  it("parses a memo this module generated (parse ∘ build is the identity)", () => {
    const memo = generateMemo("EXPENSE2");
    const parsed = parseMemo(memo);
    expect(parsed).toEqual({ ok: true, code: "EXPENSE2", memo });
  });

  it.each(["ABC234", "MP-ABC234", "mp:ABC234", ":ABC234", " MP:ABC234"])(
    "rejects %s — missing or wrong MP: prefix",
    (memo) => {
      const parsed = parseMemo(memo);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/MP:/);
    }
  );

  it.each([
    ["", /must not be empty/],
    ["MP:", /too short/],
    ["MP:abc123", /invalid characters/],
    ["MP:ABC 123", /invalid characters/],
    ["MP:ABC/123", /invalid characters/],
    ["MP:AB01", /invalid characters/],
    ["MP:ABC234\n", /invalid characters/],
    [`MP:${"A".repeat(26)}`, /28 UTF-8 bytes/],
  ])("rejects the unexpected format %j", (memo, expected) => {
    const parsed = parseMemo(memo);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(expected);
  });

  it.each([null, undefined, 123, {}])(
    "rejects non-string input %j instead of throwing",
    (input) => {
      const parsed = parseMemo(input as unknown as string);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.message).toMatch(/must be a string/);
    }
  );
});

describe("validateMemoAgainstActiveExpense — memo → active expense record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.prisma.expense.findFirst.mockResolvedValue(null);
    h.prisma.expenseShare.count.mockResolvedValue(0);
  });

  it("resolves a valid memo through the settlement's expense link", async () => {
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_1", memo: "EXP12345" });
    h.prisma.expenseShare.count.mockResolvedValue(2);

    const result = await validateMemoAgainstActiveExpense("MP:ABC234", {
      expenseId: "exp_1",
      expectedCode: "ABC234",
    });

    expect(result).toEqual({
      ok: true,
      code: "ABC234",
      memo: "MP:ABC234",
      expenseId: "exp_1",
    });
    expect(h.prisma.expense.findFirst).toHaveBeenCalledWith({
      where: { id: "exp_1" },
      select: { id: true, memo: true },
    });
    expect(h.prisma.expenseShare.count).toHaveBeenCalledWith({
      where: { expenseId: "exp_1", status: { not: "settled" } },
    });
  });

  it("matches an expense by its own memo code when no link is supplied", async () => {
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_9", memo: "ABC234" });
    h.prisma.expenseShare.count.mockResolvedValue(1);

    const result = await validateMemoAgainstActiveExpense("MP:ABC234");

    expect(result).toMatchObject({ ok: true, expenseId: "exp_9", code: "ABC234" });
    expect(h.prisma.expense.findFirst).toHaveBeenCalledWith({
      where: { memo: "ABC234" },
      select: { id: true, memo: true },
    });
  });

  it("rejects a memo with a missing prefix before touching the database", async () => {
    const result = await validateMemoAgainstActiveExpense("ABC234", {
      expenseId: "exp_1",
    });

    expect(result).toMatchObject({ ok: false, reason: "invalid_memo" });
    expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
  });

  it.each(["", "MP:", "MP:abc123", "MP:AB 123", "not-a-mergepay-memo"])(
    "rejects the unexpected format %j without querying expenses",
    async (memo) => {
      const result = await validateMemoAgainstActiveExpense(memo, {
        expenseId: "exp_1",
      });

      expect(result).toMatchObject({ ok: false, reason: "invalid_memo" });
      expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
    }
  );

  it("rejects a parsed code that differs from the expected settlement code", async () => {
    const result = await validateMemoAgainstActiveExpense("MP:ABC234", {
      expenseId: "exp_1",
      expectedCode: "EXPECT234",
    });

    expect(result).toMatchObject({ ok: false, reason: "code_mismatch", code: "ABC234" });
    if (!result.ok) {
      expect(result.message).toContain("ABC234");
      expect(result.message).toContain("EXPECT234");
    }
    expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
  });

  it("reports a linked expense record that no longer exists", async () => {
    h.prisma.expense.findFirst.mockResolvedValue(null);

    const result = await validateMemoAgainstActiveExpense("MP:ABC234", {
      expenseId: "exp_gone",
      expectedCode: "ABC234",
    });

    expect(result).toMatchObject({ ok: false, reason: "expense_not_found", code: "ABC234" });
    if (!result.ok) expect(result.message).toContain("exp_gone");
    expect(h.prisma.expenseShare.count).not.toHaveBeenCalled();
  });

  it("reports when no expense carries the parsed code", async () => {
    h.prisma.expense.findFirst.mockResolvedValue(null);

    const result = await validateMemoAgainstActiveExpense("MP:EXP2345");

    expect(result).toMatchObject({ ok: false, reason: "expense_not_found" });
    if (!result.ok) expect(result.message).toContain("EXP2345");
  });

  it("rejects an expense whose shares are all settled", async () => {
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_2", memo: "ABC234" });
    h.prisma.expenseShare.count.mockResolvedValue(0);

    const result = await validateMemoAgainstActiveExpense("MP:ABC234", {
      expenseId: "exp_2",
      expectedCode: "ABC234",
    });

    expect(result).toMatchObject({ ok: false, reason: "expense_settled", code: "ABC234" });
    if (!result.ok) expect(result.message).toContain("exp_2");
  });

  it("treats an expense with shares still pending or settling as active", async () => {
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_3", memo: "ABC234" });
    h.prisma.expenseShare.count.mockResolvedValue(1);

    const result = await validateMemoAgainstActiveExpense("MP:ABC234", {
      expenseId: "exp_3",
    });

    expect(result).toMatchObject({ ok: true, expenseId: "exp_3" });
    expect(h.prisma.expenseShare.count).toHaveBeenCalledWith({
      where: { expenseId: "exp_3", status: { not: "settled" } },
    });
  });
});
