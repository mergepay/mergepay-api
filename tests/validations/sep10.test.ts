import { describe, it, expect } from "vitest";
import { sep10VerifyRequestSchema, type Sep10VerifyRequest } from "../../src/validations/sep10";

describe("sep10VerifyRequestSchema", () => {
  const validTransaction =
    "AAAAAgAAAABhYHc5DOfcdh031qeL0LGlE7u9U/BmM9UeUl4i8Zf5kAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAACAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

  it("accepts valid transaction only", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transaction).toBe(validTransaction);
      expect(result.data.clientDomain).toBeUndefined();
    }
  });

  it("accepts valid transaction with clientDomain", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.transaction).toBe(validTransaction);
      expect(result.data.clientDomain).toBe("example.com");
    }
  });

  it("accepts valid transaction with subdomain clientDomain", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "app.example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.clientDomain).toBe("app.example.com");
    }
  });

  it("rejects missing transaction", () => {
    const result = sep10VerifyRequestSchema.safeParse({});
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("transaction"))).toBe(true);
    }
  });

  it("rejects empty transaction string", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("transaction"))).toBe(true);
    }
  });

  it("rejects transaction exceeding max length", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: "a".repeat(50001),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("transaction"))).toBe(true);
    }
  });

  it("rejects non-string transaction", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: 123,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("transaction"))).toBe(true);
    }
  });

  it("rejects empty clientDomain string", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("clientDomain"))).toBe(true);
    }
  });

  it("rejects clientDomain exceeding max length", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "a".repeat(250) + ".com",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("clientDomain"))).toBe(true);
    }
  });

  it("rejects invalid clientDomain format (no TLD)", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "example",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("clientDomain"))).toBe(true);
    }
  });

  it("rejects invalid clientDomain format (starts with hyphen)", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "-example.com",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("clientDomain"))).toBe(true);
    }
  });

  it("rejects invalid clientDomain format (ends with hyphen)", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "example-.com",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("clientDomain"))).toBe(true);
    }
  });

  it("rejects clientDomain with invalid characters", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "exam_ple.com",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("clientDomain"))).toBe(true);
    }
  });

  it("accepts clientDomain with numbers", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "example123.com",
    });
    expect(result.success).toBe(true);
  });

  it("accepts clientDomain with hyphen in middle", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      clientDomain: "my-app.example.com",
    });
    expect(result.success).toBe(true);
  });
});