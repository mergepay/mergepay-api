import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  sep10ChallengeRequestSchema,
  sep10QuerySchema,
  sep10VerifyRequestSchema,
} from "../../src/validations/sep10";

describe("sep10ChallengeRequestSchema", () => {
  const account = Keypair.random().publicKey();

  it("accepts a valid Stellar public key", () => {
    const result = sep10ChallengeRequestSchema.safeParse({ account });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ account });
  });

  it.each([
    ["missing account", {}],
    ["null account", { account: null }],
    ["numeric account", { account: 123 }],
    ["empty account", { account: "" }],
    ["non-key string", { account: "not-a-key" }],
    ["lower-cased key", { account: account.toLowerCase() }],
    ["key with surrounding whitespace", { account: ` ${account} ` }],
    ["truncated key", { account: account.slice(0, 55) }],
    ["oversized string", { account: "G".repeat(10_000) }],
    ["key with a broken checksum", { account: `${account.slice(0, 55)}${account.endsWith("A") ? "B" : "A"}` }],
    ["secret seed instead of public key", { account: Keypair.random().secret() }],
    ["muxed (M...) account", { account: StrKey.encodeMed25519PublicKey(Buffer.alloc(40)) }],
  ])("rejects %s", (_label, payload) => {
    const result = sep10ChallengeRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path[0] === "account")).toBe(true);
    }
  });

  it("rejects unknown keys instead of stripping them", () => {
    const result = sep10ChallengeRequestSchema.safeParse({ account, admin: true });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].code).toBe("unrecognized_keys");
    }
  });

  it.each([null, undefined, "GABC", [], 42])("rejects a non-object body (%s)", (payload) => {
    expect(sep10ChallengeRequestSchema.safeParse(payload).success).toBe(false);
  });
});

describe("sep10QuerySchema", () => {
  it("accepts an empty query string", () => {
    expect(sep10QuerySchema.safeParse({}).success).toBe(true);
  });

  it("rejects any query parameter", () => {
    const result = sep10QuerySchema.safeParse({ account: Keypair.random().publicKey() });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].code).toBe("unrecognized_keys");
    }
  });
});

describe("sep10VerifyRequestSchema", () => {
  const validTransaction =
    "AAAAAgAAAAC1onYLUtlHjstsPmfW5JlIT3RWjdpGH/6gVsRd9ncykQAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqtvJ3AAAAAAAAAAEAAAAAAAAACgAAAARhdXRoAAAAAQAAAAVub25jZQAAAAAAAAAAAAAA";

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

  it("accepts SEP-10 wire-format domain parameters", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      home_domain: "anchor.example.com",
      client_domain: "wallet.example.com",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.home_domain).toBe("anchor.example.com");
      expect(result.data.client_domain).toBe("wallet.example.com");
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

  it("rejects a transaction that is not base64 XDR", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: "not-xdr!",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-canonical base64 transaction data", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: "AB==",
    });
    expect(result.success).toBe(false);
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

  it("rejects unknown keys instead of stripping them", () => {
    const result = sep10VerifyRequestSchema.safeParse({
      transaction: validTransaction,
      account: "GABC",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors[0].code).toBe("unrecognized_keys");
    }
  });

  it("rejects a non-object body", () => {
    expect(sep10VerifyRequestSchema.safeParse(null).success).toBe(false);
    expect(sep10VerifyRequestSchema.safeParse(validTransaction).success).toBe(false);
  });

  it("rejects invalid home_domain and client_domain values", () => {
    expect(
      sep10VerifyRequestSchema.safeParse({
        transaction: validTransaction,
        home_domain: "-anchor.example.com",
      }).success
    ).toBe(false);
    expect(
      sep10VerifyRequestSchema.safeParse({
        transaction: validTransaction,
        client_domain: "wallet_example.com",
      }).success
    ).toBe(false);
  });
});