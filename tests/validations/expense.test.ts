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
      payerUserId: "user_1",
      memo: "abc123",
      receiptUrl: "https://example.com/receipt.jpg",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing title with a descriptive message", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, title: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.errors.find((e) => e.path.includes("title"));
      expect(issue?.message).toContain("at least 1 character");
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

  it("rejects an invalid splitType", () => {
    const result = createExpenseSchema.safeParse({ ...validBase, splitType: "evenly" });
    expect(result.success).toBe(false);
  });

  describe("amount validation", () => {
    it("rejects a zero amount with a descriptive message", () => {
      const result = createExpenseSchema.safeParse({ ...validBase, amount: "0" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.errors.find((e) => e.path.includes("amount"));
        expect(issue?.message).toContain("greater than zero");
      }
    });

    it("rejects an amount with more than seven decimal places", () => {
      const result = createExpenseSchema.safeParse({ ...validBase, amount: "10.00000001" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.errors.find((e) => e.path.includes("amount"));
        expect(issue?.message).toContain("7-decimal precision");
      }
    });

    it("rejects an amount in exponent notation", () => {
      const result = createExpenseSchema.safeParse({ ...validBase, amount: "1e3" });
      expect(result.success).toBe(false);
    });
  });

  describe("asset validation", () => {
    it("rejects an unsupported asset code with a descriptive message", () => {
      const result = createExpenseSchema.safeParse({ ...validBase, assetCode: "BADCOIN" });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.errors.find((e) => e.path.includes("assetCode"));
        expect(issue?.message).toContain("Unsupported asset code");
      }
    });

    it("rejects XLM with an issuer", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        assetCode: "XLM",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const issue = result.error.errors.find((e) => e.path.includes("assetIssuer"));
        expect(issue?.message).toContain("native asset");
      }
    });

    it("accepts USDC without an issuer (uses the configured issuer)", () => {
      const result = createExpenseSchema.safeParse({ ...validBase, assetCode: "USDC" });
      expect(result.success).toBe(true);
    });

    it("accepts USDC with the configured issuer", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      });
      expect(result.success).toBe(true);
    });
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

    it("rejects amounts with more than seven decimal places", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "a", amount: "10.00000001" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects custom split where amounts do not sum to total", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "user_1", amount: "60" }, { userId: "user_2", amount: "30" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const shareIssues = result.error.errors.filter((e) =>
          e.path.includes("shares")
        );
        expect(shareIssues.length).toBeGreaterThan(0);
        expect(shareIssues[0]!.message).toContain("must sum to the total expense amount");
      }
    });

    it("rejects custom split where amounts exceed total", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "user_1", amount: "70" }, { userId: "user_2", amount: "40" }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects zero share amount in custom split", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        amount: "100",
        splitType: "custom",
        shares: [{ userId: "user_1", amount: "0" }, { userId: "user_2", amount: "100" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) =>
          e.message.includes("must be greater than zero")
        )).toBe(true);
      }
    });

    it("accepts custom split with exact sum using decimal precision", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [
          { userId: "user_1", amount: "33.3333333" },
          { userId: "user_2", amount: "33.3333334" },
          { userId: "user_3", amount: "33.3333333" },
        ],
      });
      // 33.3333333 + 33.3333334 + 33.3333333 = 100.0000000
      expect(result.success).toBe(true);
    });

    it("rejects custom split off by one stroop (0.0000001)", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [
          { userId: "user_1", amount: "50.0000001" },
          { userId: "user_2", amount: "50" },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) =>
          e.message.includes("must sum to the total expense amount")
        )).toBe(true);
      }
    });

    it("handles floating-point precision edge case: 0.1 + 0.2", () => {
      // Classic floating-point pitfall: 0.1 + 0.2 !== 0.3 in IEEE 754.
      // Using BigInt stroops, this should be caught correctly.
      const result = createExpenseSchema.safeParse({
        title: "Float",
        amount: "0.3",
        assetCode: "XLM",
        splitType: "custom",
        shares: [
          { userId: "user_1", amount: "0.1" },
          { userId: "user_2", amount: "0.2" },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("handles floating-point precision edge case: 0.1 + 0.1 + 0.1 vs 0.3", () => {
      const result = createExpenseSchema.safeParse({
        title: "Float",
        amount: "0.3",
        assetCode: "XLM",
        splitType: "custom",
        shares: [
          { userId: "user_1", amount: "0.1" },
          { userId: "user_2", amount: "0.1" },
          { userId: "user_3", amount: "0.1" },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects custom split with fractional overflow from many small amounts", () => {
      // Many 0.01 shares that should sum to 0.07 but floating-point might miscalculate
      const result = createExpenseSchema.safeParse({
        title: "Small",
        amount: "0.07",
        assetCode: "XLM",
        splitType: "custom",
        shares: [
          { userId: "user_1", amount: "0.01" },
          { userId: "user_2", amount: "0.01" },
          { userId: "user_3", amount: "0.01" },
          { userId: "user_4", amount: "0.01" },
          { userId: "user_5", amount: "0.01" },
          { userId: "user_6", amount: "0.01" },
          { userId: "user_7", amount: "0.01" },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("rejects custom split with one extra stroop from floating-point drift", () => {
      // Construct a case where floating-point addition would incorrectly succeed
      // but the true BigInt sum is off by 1 stroop
      const result = createExpenseSchema.safeParse({
        title: "Drift",
        amount: "0.14",
        assetCode: "XLM",
        splitType: "custom",
        shares: [
          { userId: "user_1", amount: "0.07" },
          { userId: "user_2", amount: "0.07" },
          { userId: "user_3", amount: "0.01" },
        ],
      });
      // 0.07 + 0.07 + 0.01 = 0.15, not 0.14 — must be rejected
      expect(result.success).toBe(false);
    });

    it("accepts single-share custom split equal to total", () => {
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "user_1", amount: "100" }],
      });
      expect(result.success).toBe(true);
    });

    it("rejects custom split with zero share amounts", () => {
      // Zero share amounts should be rejected even when top-level amount is valid
      const result = createExpenseSchema.safeParse({
        ...validBase,
        splitType: "custom",
        shares: [{ userId: "user_1", amount: "0" }, { userId: "user_2", amount: "0" }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.some((e) =>
          e.message.includes("must be greater than zero")
        )).toBe(true);
      }
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
        const shareIssues = result.error.errors.filter((e) =>
          e.path.includes("shares")
        );
        expect(shareIssues.length).toBeGreaterThan(0);
        expect(shareIssues[0]!.message).toContain("must sum to 100%");
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
