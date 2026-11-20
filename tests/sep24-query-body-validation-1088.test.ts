import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
  sep24InitQuerySchema,
} from "../src/schemas/sep24";

const account = Keypair.random().publicKey();

describe("SEP-24 deposit/withdraw schemas (#1088)", () => {
  it("accepts valid deposit and withdrawal requests", () => {
    expect(sep24DepositRequestSchema.safeParse({ assetCode: "usdc", account }).success).toBe(true);
    expect(
      sep24WithdrawRequestSchema.safeParse({ assetCode: "USDC", amount: "10.5", account, memo: "abc", memoType: "text" })
        .success
    ).toBe(true);
  });

  it("rejects missing mandatory parameters", () => {
    expect(sep24DepositRequestSchema.safeParse({ account }).success).toBe(false);
    expect(sep24WithdrawRequestSchema.safeParse({ assetCode: "USDC", account }).success).toBe(false);
  });

  it("rejects invalid asset codes and accounts", () => {
    expect(sep24DepositRequestSchema.safeParse({ assetCode: "BAD-CODE!", account }).success).toBe(false);
    expect(sep24DepositRequestSchema.safeParse({ assetCode: "A".repeat(13), account }).success).toBe(false);
    expect(sep24DepositRequestSchema.safeParse({ assetCode: "USDC", account: "GNOTAKEY" }).success).toBe(false);
  });

  it("rejects malformed memos for their memo type", () => {
    const base = { assetCode: "USDC", account };
    expect(sep24DepositRequestSchema.safeParse({ ...base, memo: "abc", memoType: "id" }).success).toBe(false);
    expect(sep24DepositRequestSchema.safeParse({ ...base, memo: "x".repeat(40), memoType: "text" }).success).toBe(false);
    expect(sep24DepositRequestSchema.safeParse({ ...base, memo: "123", memoType: "id" }).success).toBe(true);
  });

  it("rejects unexpected extra body and query parameters", () => {
    expect(sep24DepositRequestSchema.safeParse({ assetCode: "USDC", account, extra: 1 }).success).toBe(false);
    expect(sep24InitQuerySchema.safeParse({ asset_code: "XLM" }).success).toBe(false);
    expect(sep24InitQuerySchema.safeParse({ lang: "en" }).success).toBe(true);
  });
});
