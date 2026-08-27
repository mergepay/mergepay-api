import { describe, expect, it } from "vitest";
import { sep24InteractiveSchema } from "../../src/schemas/sep24";

describe("SEP-24 interactive parameters", () => {
  it("accepts a valid asset and memo pair", () => {
    const result = sep24InteractiveSchema.safeParse({
      assetCode: "USDC",
      account: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      memo: "invoice-42",
      memoType: "text",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a memo without a memo type", () => {
    const result = sep24InteractiveSchema.safeParse({ assetCode: "XLM", memo: "42" });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid account and unsupported memo type", () => {
    const result = sep24InteractiveSchema.safeParse({
      assetCode: "XLM",
      account: "not-a-stellar-account",
      memo: "42",
      memoType: "binary",
    });
    expect(result.success).toBe(false);
  });
});
