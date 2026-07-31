import { describe, it, expect } from "vitest";
import {
  createExpenseSchema,
  updateExpenseSchema,
  SplitType,
} from "../../src/validations/expense";

describe("createExpenseSchema", () => {
  const validBase = {
    title: "Dinner",
    amount: "100",
    assetCode: "XLM",
    splitType: "equal" as const,
    shares: [{ userId: "user_1" }, { userId: "user_2" }],
  };

  it("accepts valid equal split", () => {
    const result = createExpenseSchema.safeParse(validBase);
    expect(result.success).toBe(true);
  });

  it("accepts valid custom split with amounts", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      splitType: "custom",
      shares: [{ userId: "user_1", amount: "60" }, { userId: "user_2", amount: "40" }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid percentage split summing to 100", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      splitType: "percentage",
      shares: [{ userId: "user_1", percent: 60 }, { userId: "user_2", percent: 40 }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts optional fields", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      description: "Team dinner",
      assetIssuer: "GAAAA...",
      payerUserId: "user_1",
      memo: "abc123",
      receiptUrl: "https://example.com/receipt.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing title", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, title: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("title"))).toBe(true);
    }
  });

  it("rejects title too long", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, title: "a".repeat(81) });
    expect(result.success).toBe(false);
  });

  it("rejects missing amount", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, amount: "" });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, amount: "-10" });
    expect(result.success).toBe(false);
  });

  it("rejects missing assetCode", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, assetCode: "" });
    expect(result.success).toBe(false);
  });

  it("rejects empty shares array", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, shares: [] });
    expect(result.success).toBe(false);
  });

  it("rejects share without userId", () => {
    const result = createExpenseSchema.safeParse({
      ...validBase,
      shares: [{ userId: "" }],
    });
    expect(result.success).toBe(false);
  });

  describe("custom split validation", () => {
    it("rejects custom split without amounts", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "user_1" }, { userId: "user_2" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) => e.path.includes("shares"))).toBe(true);
      }
    });

    it("rejects custom split with empty amount", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "user_1", amount: "" }, { userId: "user_2", amount: "40" }],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("percentage split validation", () => {
    it("rejects percentage split without percents", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "percentage",
        shares: [{ userId: "user_1" }, { userId: "user_2" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects percentage split not summing to 100", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "percentage",
        shares: [{ userId: "user_1", percent: 60 }, { userId: "user_2", percent: 30 }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) => e.path.includes("shares"))).toBe(true);
      }
    });

    it("rejects percentage over 100", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "percentage",
        shares: [{ userId: "user_1", percent: 150 }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects negative percentage", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "percentage",
        shares: [{ userId: "user_1", percent: -10 }],
      });
      expect(result.success).toBe(false);
    });

    it("accepts percentage sum within 0.01 tolerance", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "percentage",
        shares: [
          { userId: "user_1", percent: 33.33 },
          { userId: "user_2", percent: 33.33 },
          { userId: "user_3", percent: 33.34 },
        ],
      });
      expect(result.success).toBe(true);
    });
  });
});

describe("updateExpenseSchema", () => {
  it("accepts valid partial update", () => {
    const result = updateExpenseSchema.safeParse({
      title: "New Title",
      description: "Updated",
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty object", () => {
    const result = updateExpenseSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects empty title", () => {
    const result = updateExpenseSchema.safeParse({ title: "" });
    expect(result.success).toBe(false);
  });

  it("rejects title too long", () => {
    const result = updateExpenseSchema.safeParse({ title: "a".repeat(81) });
    expect(result.success).toBe(false);
  });

  it("rejects description too long", () => {
    const result = updateExpenseSchema.safeParse({ description: "a".repeat(501) });
    expect(result.success).toBe(false);
  });

  it("rejects memo too long", () => {
    const result = updateExpenseSchema.safeParse({ memo: "a".repeat(25) });
    expect(result.success).toBe(false);
  });

  it("accepts nullable description", () => {
    const result = updateExpenseSchema.safeParse({ description: null });
    expect(result.success).toBe(true);
  });

  it("accepts nullable receiptUrl", () => {
    const result = updateExpenseSchema.safeParse({ receiptUrl: null });
    expect(result.success).toBe(true);
  });
});

describe("SplitType enum", () => {
  it("accepts valid split types", () => {
    expect(SplitType.safeParse("equal").success).toBe(true);
    expect(SplitType.safeParse("custom").success).toBe(true);
    expect(SplitType.safeParse("percentage").success).toBe(true);
  });

  it("rejects invalid split type", () => {
    const result = SplitType.safeParse("invalid");
    expect(result.success).toBe(false);
  });
});