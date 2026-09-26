/**
 * Tests for SEP-24 callback validation schemas (issue #358).
 *
 * Covers both the body schema (sep24CallbackSchema) used by JWT-authenticated
 * and HMAC-authenticated callback routes, and the query-parameter schema
 * (sep24CallbackQuerySchema) used by the JWT callback endpoint.
 */
import { describe, it, expect } from "vitest";
import {
  sep24CallbackQuerySchema,
  sep24DepositRequestSchema,
  sep24WithdrawRequestSchema,
} from "../../src/validations/sep24";
import {
  sep24CallbackSchema,
} from "../../src/services/sep24-anchor-token";

// ─── sep24CallbackSchema (body) ──────────────────────────────────────────────

describe("sep24CallbackSchema", () => {
  describe("accepts valid payloads", () => {
    it("accepts a minimal callback with transaction envelope", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "txn_123", status: "completed" },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalTransactionId).toBe("txn_123");
        expect(result.data.rawStatus).toBe("completed");
      }
    });

    it("accepts a callback with top-level id and status", () => {
      const result = sep24CallbackSchema.safeParse({
        id: "ext_456",
        status: "pending_anchor",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.externalTransactionId).toBe("ext_456");
        expect(result.data.rawStatus).toBe("pending_anchor");
      }
    });

    it("accepts a fully-specified transaction envelope", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: {
          id: "txn_789",
          status: "completed",
          kind: "deposit",
          amount_in: "100.00",
          amount_out: "99.50",
          amount_fee: "0.50",
          stellar_transaction_id: "a".repeat(64),
          external_transaction_id: "ext_789",
          message: "Transfer completed",
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amountIn).toBe("100.00");
        expect(result.data.amountOut).toBe("99.50");
        expect(result.data.amountFee).toBe("0.50");
        expect(result.data.stellarTransactionId).toBe("a".repeat(64));
        expect(result.data.message).toBe("Transfer completed");
      }
    });

    it("accepts unknown extra fields (passthrough)", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "txn_abc", status: "error" },
        custom_anchor_field: "value",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("rejects invalid payloads", () => {
    it("rejects an empty body", () => {
      const result = sep24CallbackSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it("rejects body with only a status but no id", () => {
      const result = sep24CallbackSchema.safeParse({
        status: "completed",
      });
      expect(result.success).toBe(false);
    });

    it("rejects body with only an id but no status", () => {
      const result = sep24CallbackSchema.safeParse({
        id: "txn_123",
      });
      expect(result.success).toBe(false);
    });

    it("rejects transaction with empty id", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "", status: "completed" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects transaction with empty status", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "txn_123", status: "" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects transaction with id exceeding max length", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "x".repeat(256), status: "completed" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects transaction with status exceeding max length", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "txn_123", status: "x".repeat(65) },
      });
      expect(result.success).toBe(false);
    });

    it("rejects non-object body", () => {
      expect(sep24CallbackSchema.safeParse(null).success).toBe(false);
      expect(sep24CallbackSchema.safeParse("string").success).toBe(false);
      expect(sep24CallbackSchema.safeParse(42).success).toBe(false);
      expect(sep24CallbackSchema.safeParse([]).success).toBe(false);
    });

    it("rejects transaction with non-string id", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: 123, status: "completed" },
      });
      expect(result.success).toBe(false);
    });

    it("rejects transaction with non-string status", () => {
      const result = sep24CallbackSchema.safeParse({
        transaction: { id: "txn_123", status: 42 },
      });
      expect(result.success).toBe(false);
    });

    it.each(["abc123def456", "g".repeat(64)])(
      "rejects malformed Stellar transaction hash %s",
      (stellarTransactionId) => {
        const result = sep24CallbackSchema.safeParse({
          transaction: {
            id: "txn_123",
            status: "completed",
            stellar_transaction_id: stellarTransactionId,
          },
        });
        expect(result.success).toBe(false);
      }
    );
  });
});

// ─── sep24CallbackQuerySchema (query parameters) ─────────────────────────────

describe("sep24CallbackQuerySchema", () => {
  it("accepts an empty query (all params optional)", () => {
    const result = sep24CallbackQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a valid lang parameter", () => {
    const result = sep24CallbackQuerySchema.safeParse({ lang: "en" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lang).toBe("en");
  });

  it("accepts lang with regional variant", () => {
    const result = sep24CallbackQuerySchema.safeParse({ lang: "en-US" });
    expect(result.success).toBe(true);
  });

  it("rejects unknown query parameters", () => {
    const result = sep24CallbackQuerySchema.safeParse({ unexpected: "value" });
    expect(result.success).toBe(false);
  });

  it("rejects lang that is too short", () => {
    const result = sep24CallbackQuerySchema.safeParse({ lang: "e" });
    expect(result.success).toBe(false);
  });

  it("rejects lang that is too long", () => {
    const result = sep24CallbackQuerySchema.safeParse({ lang: "x".repeat(11) });
    expect(result.success).toBe(false);
  });

  it("rejects non-string lang", () => {
    const result = sep24CallbackQuerySchema.safeParse({ lang: 123 });
    expect(result.success).toBe(false);
  });

  it("rejects multiple unknown parameters", () => {
    const result = sep24CallbackQuerySchema.safeParse({
      foo: "bar",
      baz: 42,
    });
    expect(result.success).toBe(false);
  });
});

// ─── Deposit/withdraw request schemas (body) ─────────────────────────────────

describe("sep24DepositRequestSchema — callback-relevant edge cases", () => {
  it("rejects a body with empty assetCode", () => {
    const result = sep24DepositRequestSchema.safeParse({ assetCode: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a body with missing assetCode", () => {
    const result = sep24DepositRequestSchema.safeParse({ amount: "10" });
    expect(result.success).toBe(false);
  });

  it("rejects a body with non-string assetCode", () => {
    const result = sep24DepositRequestSchema.safeParse({ assetCode: 123 });
    expect(result.success).toBe(false);
  });
});

describe("sep24WithdrawRequestSchema — callback-relevant edge cases", () => {
  it("requires amount for withdrawal", () => {
    const result = sep24WithdrawRequestSchema.safeParse({ assetCode: "USDC" });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive amount", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative amount", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "-5",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-string amount", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: 10,
    });
    expect(result.success).toBe(false);
  });
});
