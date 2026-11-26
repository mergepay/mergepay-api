/**
 * Unit tests for SEP-24 transaction-list query schema — Issue #1139.
 *
 * Verifies that `sep24TransactionsQuerySchema` accepts the full range of valid
 * SEP-24 and pagination parameters, applies the correct defaults, and rejects
 * invalid inputs before they reach the database.
 */
import { describe, it, expect } from "vitest";
import { sep24TransactionsQuerySchema } from "../sep24";

describe("sep24TransactionsQuerySchema — valid inputs", () => {
  it("accepts an empty query and applies pagination defaults", () => {
    const result = sep24TransactionsQuerySchema.safeParse({});

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.limit).toBe(50);
      expect(result.data.order).toBe("desc");
      expect(result.data.cursor).toBeUndefined();
    }
  });

  it("accepts kind=deposit", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ kind: "deposit" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe("deposit");
  });

  it("accepts kind=withdrawal", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ kind: "withdrawal" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe("withdrawal");
  });

  it("accepts a valid asset_code", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ asset_code: "USDC" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.asset_code).toBe("USDC");
  });

  it("accepts a valid SEP-24 status", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ status: "completed" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.status).toBe("completed");
  });

  it("accepts a pending_user_transfer_start status", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      status: "pending_user_transfer_start",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a string limit and coerces it to a number", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ limit: "10" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(10);
  });

  it("accepts limit at the maximum boundary (100)", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ limit: "100" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.limit).toBe(100);
  });

  it("accepts order=asc", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ order: "asc" });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.order).toBe("asc");
  });

  it("accepts a cursor string", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      cursor: "eyJpZCI6ImNsZXhhbXBsZSJ9",
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.cursor).toBeDefined();
  });

  it("accepts an ISO date range", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      startDate: "2024-01-01T00:00:00.000Z",
      endDate: "2024-12-31T23:59:59.999Z",
    });

    expect(result.success).toBe(true);
  });

  it("accepts a lang parameter", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ lang: "en" });

    expect(result.success).toBe(true);
  });

  it("accepts all optional fields together", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      kind: "deposit",
      asset_code: "USDC",
      status: "completed",
      limit: "25",
      order: "asc",
      cursor: "abc123",
      startDate: "2024-01-01T00:00:00.000Z",
      endDate: "2024-06-30T00:00:00.000Z",
      lang: "pt",
    });

    expect(result.success).toBe(true);
  });
});

describe("sep24TransactionsQuerySchema — invalid inputs", () => {
  it("rejects an invalid kind value", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      kind: "transfer",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("kind"))).toBe(true);
    }
  });

  it("rejects a non-numeric limit string", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      limit: "ten",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("limit"))).toBe(true);
    }
  });

  it("rejects limit=0 (below minimum)", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ limit: "0" });

    expect(result.success).toBe(false);
  });

  it("rejects limit exceeding maximum (101)", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ limit: "101" });

    expect(result.success).toBe(false);
  });

  it("rejects an invalid status value", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      status: "not_a_real_status",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path.includes("status"))).toBe(true);
    }
  });

  it("rejects an invalid order value", () => {
    const result = sep24TransactionsQuerySchema.safeParse({ order: "newest" });

    expect(result.success).toBe(false);
  });

  it("rejects an asset_code that is too long (over 12 chars)", () => {
    const result = sep24TransactionsQuerySchema.safeParse({
      asset_code: "TOOLONGASSETCODE",
    });

    expect(result.success).toBe(false);
  });
});
