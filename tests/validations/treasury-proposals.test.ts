import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  treasuryProposalCreateSchema,
  treasuryProposalGroupParamsSchema,
  treasuryProposalParamsSchema,
  treasuryProposalSignSchema,
  treasuryProposalSubmitSchema,
} from "../../src/validations/treasury";

const destination = Keypair.random().publicKey();

const validCreate = {
  destination,
  amount: "5",
  assetCode: "XLM",
};

describe("treasuryProposalCreateSchema", () => {
  it("accepts a valid XLM proposal", () => {
    expect(treasuryProposalCreateSchema.safeParse(validCreate).success).toBe(true);
  });

  it("accepts an optional Mergepay memo", () => {
    expect(
      treasuryProposalCreateSchema.safeParse({
        ...validCreate,
        memo: "MP:abc123",
      }).success
    ).toBe(true);
  });

  it("rejects an invalid destination public key", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      destination: "not-a-key",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("destination"))).toBe(true);
    }
  });

  it("rejects a zero amount with a descriptive message", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      amount: "0",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.errors.find((e) => e.path.includes("amount"));
      expect(issue?.message).toContain("greater than zero");
    }
  });

  it("rejects a negative amount", () => {
    expect(
      treasuryProposalCreateSchema.safeParse({ ...validCreate, amount: "-1" })
        .success
    ).toBe(false);
  });

  it("rejects excess decimal precision", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      amount: "1.00000001",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.errors.find((e) => e.path.includes("amount"));
      expect(issue?.message).toContain("7-decimal precision");
    }
  });

  it("rejects an amount in exponent notation", () => {
    expect(
      treasuryProposalCreateSchema.safeParse({ ...validCreate, amount: "1e3" })
        .success
    ).toBe(false);
  });

  it("rejects an unsupported asset code", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      assetCode: "BADCOIN",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("assetCode"))).toBe(true);
    }
  });

  it("rejects the native asset supplied with an issuer", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      assetIssuer: destination,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("assetIssuer"))).toBe(true);
    }
  });

  it("rejects a memo without the Mergepay prefix", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      memo: "abc123",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.errors.some((e) => e.path.includes("memo"))).toBe(true);
    }
  });

  it("rejects a memo longer than a Stellar memo text", () => {
    const result = treasuryProposalCreateSchema.safeParse({
      ...validCreate,
      memo: `MP:${"a".repeat(30)}`,
    });
    expect(result.success).toBe(false);
  });
});

describe("treasuryProposalSignSchema", () => {
  it("accepts a non-empty signed XDR", () => {
    expect(treasuryProposalSignSchema.safeParse({ signedXdr: "AAAA" }).success).toBe(true);
  });

  it("rejects an empty signed XDR", () => {
    const result = treasuryProposalSignSchema.safeParse({ signedXdr: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.errors.find((e) => e.path.includes("signedXdr"));
      expect(issue?.message).toContain("required");
    }
  });

  it("rejects a missing signed XDR", () => {
    expect(treasuryProposalSignSchema.safeParse({}).success).toBe(false);
  });

  it("rejects an oversized signed XDR", () => {
    expect(
      treasuryProposalSignSchema.safeParse({ signedXdr: "A".repeat(100_001) })
        .success
    ).toBe(false);
  });

  it("shares its shape with the submission payload", () => {
    expect(treasuryProposalSubmitSchema).toBe(treasuryProposalSignSchema);
  });
});

describe("treasury proposal path parameters", () => {
  it("accepts a group id", () => {
    expect(
      treasuryProposalGroupParamsSchema.safeParse({ groupId: "group_1" }).success
    ).toBe(true);
  });

  it("rejects an empty group id", () => {
    expect(
      treasuryProposalGroupParamsSchema.safeParse({ groupId: "" }).success
    ).toBe(false);
  });

  it("accepts a group and proposal id", () => {
    expect(
      treasuryProposalParamsSchema.safeParse({
        groupId: "group_1",
        proposalId: "prop_1",
      }).success
    ).toBe(true);
  });

  it("rejects an empty proposal id", () => {
    expect(
      treasuryProposalParamsSchema.safeParse({
        groupId: "group_1",
        proposalId: "",
      }).success
    ).toBe(false);
  });

  it("rejects an oversized identifier", () => {
    expect(
      treasuryProposalParamsSchema.safeParse({
        groupId: "g".repeat(65),
        proposalId: "prop_1",
      }).success
    ).toBe(false);
  });
});
