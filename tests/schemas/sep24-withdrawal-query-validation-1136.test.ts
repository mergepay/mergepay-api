/**
 * SEP-24 anchor withdrawal query and transaction parameter validation (#1136).
 *
 * Verifies that the Zod schemas for every SEP-24 withdrawal surface:
 *   - POST /withdraw (Mergepay's own withdrawal initiation body)
 *   - GET  /withdraw/:id / POST /withdraw/:id/confirm  (path params)
 *   - POST /anchors/withdraw / POST /api/sep24/withdraw (interactive request body)
 *   - GET  /api/sep24/transaction (transaction status query)
 *
 * …reject malformed or missing parameters with structured errors before any
 * anchor I/O or database work happens.  All assertions use the pure Zod schemas
 * and the route-level middleware — no database or HTTP server is needed.
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  sep24WithdrawalRequestBodySchema,
  sep24WithdrawalParamsSchema,
  sep24WithdrawRequestSchema,
  sep24TransactionQuerySchema,
  sep24WithdrawParamsSchema,
  validateSep24WithdrawParams,
} from "../../src/schemas/sep24";

const validKey = Keypair.random().publicKey();

// ── POST /withdraw body ──────────────────────────────────────────────────────

describe("sep24WithdrawalRequestBodySchema — POST /withdraw body (#1136)", () => {
  it("accepts a valid withdrawal body", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "50.00",
      assetCode: "USDC",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a withdrawal body with optional memo", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "10.0000001",
      assetCode: "XLM",
      memo: "MP:ABC123",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when amount is missing", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      assetCode: "USDC",
    });
    expect(result.success).toBe(false);
    const flat = result.error!.flatten();
    expect(flat.fieldErrors.amount).toBeDefined();
  });

  it("rejects when assetCode is missing", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "10.00",
    });
    expect(result.success).toBe(false);
    const flat = result.error!.flatten();
    expect(flat.fieldErrors.assetCode).toBeDefined();
  });

  it("rejects amount with more than 7 decimal places", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "1.12345678",
      assetCode: "USDC",
    });
    expect(result.success).toBe(false);
  });

  it("rejects amount that is not a decimal string", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "not_a_number",
      assetCode: "USDC",
    });
    expect(result.success).toBe(false);
  });

  it("rejects assetCode with invalid characters", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "10.00",
      assetCode: "USD$COIN",
    });
    expect(result.success).toBe(false);
  });

  it("rejects assetCode longer than 12 characters", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "10.00",
      assetCode: "TOOLONGASSETCODE",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra fields (strict mode)", () => {
    const result = sep24WithdrawalRequestBodySchema.safeParse({
      amount: "10.00",
      assetCode: "USDC",
      unexpectedField: "injected",
    });
    expect(result.success).toBe(false);
  });
});

// ── GET /withdraw/:id — path parameter ──────────────────────────────────────

describe("sep24WithdrawalParamsSchema — GET /withdraw/:id path params (#1136)", () => {
  it("accepts a non-empty id", () => {
    const result = sep24WithdrawalParamsSchema.safeParse({ id: "withdrawal_abc123" });
    expect(result.success).toBe(true);
  });

  it("rejects an empty id", () => {
    const result = sep24WithdrawalParamsSchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects when id is absent", () => {
    const result = sep24WithdrawalParamsSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ── POST /anchors/withdraw or /api/sep24/withdraw — interactive request body ─

describe("sep24WithdrawRequestSchema — interactive withdrawal body (#1136)", () => {
  it("accepts a valid withdrawal with assetCode and amount", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "usdc",
      amount: "100.00",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assetCode).toBe("USDC");
    }
  });

  it("requires amount on a withdrawal request", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
    });
    expect(result.success).toBe(false);
  });

  it("requires assetCode", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      amount: "10.00",
    });
    expect(result.success).toBe(false);
  });

  it("validates account as a Stellar public key when present", () => {
    const invalid = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      account: "not-a-stellar-key",
    });
    expect(invalid.success).toBe(false);

    const valid = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      account: validKey,
    });
    expect(valid.success).toBe(true);
  });

  it("validates to field as a Stellar public key when present", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      to: "bad-key",
    });
    expect(result.success).toBe(false);
  });

  it("requires memoType when memo is supplied", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      memo: "some-memo",
    });
    expect(result.success).toBe(false);
  });

  it("requires memo when memoType is supplied", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      memoType: "text",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid memo + memoType pair", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      memo: "order-123",
      memoType: "text",
    });
    expect(result.success).toBe(true);
  });

  it("rejects XLM with an assetIssuer", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "XLM",
      amount: "10.00",
      assetIssuer: validKey,
    });
    expect(result.success).toBe(false);
  });

  it("normalises assetCode to uppercase", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "usdc",
      amount: "5.00",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assetCode).toBe("USDC");
    }
  });

  it("rejects unknown extra fields (strict)", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "10.00",
      hackField: "value",
    });
    expect(result.success).toBe(false);
  });
});

// ── GET /api/sep24/transaction — transaction status query ────────────────────

describe("sep24TransactionQuerySchema — transaction status query (#1136)", () => {
  it("accepts a valid opaque transaction id", () => {
    const result = sep24TransactionQuerySchema.safeParse({
      id: "anchor:session:abc-123",
    });
    expect(result.success).toBe(true);
  });

  it("accepts id with lang parameter", () => {
    const result = sep24TransactionQuerySchema.safeParse({
      id: "tx_abc",
      lang: "en-US",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when id is missing", () => {
    const result = sep24TransactionQuerySchema.safeParse({});
    expect(result.success).toBe(false);
    const flat = result.error!.flatten();
    expect(flat.fieldErrors.id).toBeDefined();
  });

  it("rejects an empty id string", () => {
    const result = sep24TransactionQuerySchema.safeParse({ id: "" });
    expect(result.success).toBe(false);
  });

  it("rejects id exceeding 120 characters", () => {
    const result = sep24TransactionQuerySchema.safeParse({ id: "x".repeat(121) });
    expect(result.success).toBe(false);
  });

  it("rejects id with whitespace characters", () => {
    const result = sep24TransactionQuerySchema.safeParse({ id: "tx id with spaces" });
    expect(result.success).toBe(false);
  });

  it("rejects unknown extra query parameters (strict)", () => {
    const result = sep24TransactionQuerySchema.safeParse({
      id: "tx_abc",
      injectedParam: "hack",
    });
    expect(result.success).toBe(false);
  });
});

// ── sep24WithdrawParamsSchema — wire-format withdrawal params ────────────────

describe("sep24WithdrawParamsSchema / validateSep24WithdrawParams — wire format (#1136)", () => {
  it("accepts snake_case wire parameters", () => {
    const params = validateSep24WithdrawParams({
      asset_code: "usdc",
      amount: "75.25",
      account: validKey,
    });
    expect(params).toBeTruthy();
  });

  it("accepts camelCase parameters", () => {
    const params = validateSep24WithdrawParams({
      assetCode: "USDC",
      amount: "10.00",
    });
    expect(params).toBeTruthy();
  });

  it("rejects when amount is missing in wire format", () => {
    expect(() =>
      validateSep24WithdrawParams({ asset_code: "USDC" })
    ).toThrow(/amount is required/);
  });

  it("rejects when asset_code is missing in wire format", () => {
    expect(() =>
      validateSep24WithdrawParams({ amount: "10.00" })
    ).toThrow(/asset_code is required/);
  });

  it("rejects negative amount", () => {
    expect(() =>
      validateSep24WithdrawParams({ asset_code: "USDC", amount: "-10.00" })
    ).toThrow();
  });

  it("rejects zero amount", () => {
    expect(() =>
      validateSep24WithdrawParams({ asset_code: "USDC", amount: "0" })
    ).toThrow();
  });

  it("validates withdrawal query parameters via schema alias sep24WithdrawParamsSchema", () => {
    const result = sep24WithdrawParamsSchema.safeParse({
      asset_code: "USDC",
      amount: "10.00",
    });
    expect(result.success).toBe(true);
  });
});
