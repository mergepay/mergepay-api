import { describe, it, expect } from "vitest";
import { createExpenseSchema } from "../src/validations/expense";

describe("expense creation Zod validation", () => {
  it("accepts a valid expense payload with XLM", () => {
    const valid = {
      title: "Dinner",
      amount: "30",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }, { userId: "user2" }],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("accepts USDC with configured issuer", () => {
    const valid = {
      title: "Lunch",
      amount: "15.50",
      assetCode: "USDC",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }, { userId: "user2" }],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("rejects negative amount", () => {
    const invalid = {
      title: "Bad",
      amount: "-10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects zero amount", () => {
    const invalid = {
      title: "Zero",
      amount: "0",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects non-numeric amount", () => {
    const invalid = {
      title: "NaN",
      amount: "abc",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects unsupported asset code", () => {
    const invalid = {
      title: "Euro",
      amount: "100",
      assetCode: "EUR",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects percentage split not summing to 100%", () => {
    const invalid = {
      title: "Over",
      amount: "100",
      assetCode: "XLM",
      splitType: "percentage" as const,
      shares: [
        { userId: "user1", percent: 60 },
        { userId: "user2", percent: 50 },
      ],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("accepts percentage split exactly at 100%", () => {
    const valid = {
      title: "Exact",
      amount: "100",
      assetCode: "XLM",
      splitType: "percentage" as const,
      shares: [
        { userId: "user1", percent: 60 },
        { userId: "user2", percent: 40 },
      ],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("rejects invalid receipt URL", () => {
    const invalid = {
      title: "Bad URL",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
      receiptUrl: "not-a-url",
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("accepts null receipt URL", () => {
    const valid = {
      title: "No Receipt",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
      receiptUrl: null,
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("accepts valid receipt URL", () => {
    const valid = {
      title: "With Receipt",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
      receiptUrl: "https://example.com/receipt.pdf",
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });

  it("rejects empty shares array", () => {
    const invalid = {
      title: "No Shares",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects title longer than 80 characters", () => {
    const invalid = {
      title: "A".repeat(81),
      amount: "10",
      assetCode: "XLM",
      splitType: "equal" as const,
      shares: [{ userId: "user1" }],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("rejects custom split where amounts don't match total", () => {
    const invalid = {
      title: "Mismatched",
      amount: "100",
      assetCode: "XLM",
      splitType: "custom" as const,
      shares: [
        { userId: "user1", amount: "60" },
        { userId: "user2", amount: "30" },
      ],
    };
    expect(() => createExpenseSchema.parse(invalid)).toThrow();
  });

  it("accepts custom split where amounts match total", () => {
    const valid = {
      title: "Matched",
      amount: "100",
      assetCode: "XLM",
      splitType: "custom" as const,
      shares: [
        { userId: "user1", amount: "60" },
        { userId: "user2", amount: "40" },
      ],
    };
    expect(() => createExpenseSchema.parse(valid)).not.toThrow();
  });
});
