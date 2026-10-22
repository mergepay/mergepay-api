/**
 * Tests for the treasury multisig proposal creation schema (issue #402).
 *
 * `treasuryTxProposalCreateSchema` gates `POST /api/treasury/proposals`
 * (src/routes/treasury-signatures.ts), so these tests cover the payload shape
 * the route now enforces: a required treasury id under either of its accepted
 * names (`treasuryId` or the legacy `groupId`), a parseable transaction XDR,
 * and an optional bounded description. Semantic envelope checks (unsigned,
 * treasury-sourced, treasury enabled) stay in the service and are covered in
 * tests/services/treasury.test.ts.
 */
import { describe, it, expect } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  treasuryTxProposalCreateSchema,
  treasuryXdrSchema,
} from "../../src/validations/treasury";

/** A structurally valid, unsigned transaction envelope. */
function validXdr(): string {
  return new TransactionBuilder(
    new Account(Keypair.random().publicKey(), "0"),
    { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
  )
    .addOperation(Operation.manageData({ name: "proposal-test", value: "value" }))
    .setTimeout(60)
    .build()
    .toXDR();
}

function validPayload(over: Record<string, unknown> = {}) {
  return { treasuryId: "treasury_1", xdr: validXdr(), ...over };
}

describe("treasuryXdrSchema", () => {
  it("accepts a valid unsigned transaction XDR", () => {
    expect(treasuryXdrSchema.safeParse(validXdr()).success).toBe(true);
  });

  it("rejects an empty XDR", () => {
    expect(treasuryXdrSchema.safeParse("").success).toBe(false);
  });

  it("rejects input that is not base64", () => {
    expect(treasuryXdrSchema.safeParse("not-an-xdr!!").success).toBe(false);
  });

  it("rejects valid base64 that is not a transaction envelope", () => {
    const bogus = Buffer.from("definitely not an xdr envelope").toString("base64");
    expect(treasuryXdrSchema.safeParse(bogus).success).toBe(false);
  });

  it("rejects a corrupted envelope that is still canonical base64", () => {
    const bytes = Buffer.from(validXdr(), "base64");
    bytes[0] ^= 0x80; // break the envelope-type word
    expect(treasuryXdrSchema.safeParse(bytes.toString("base64")).success).toBe(false);
  });
});

describe("treasuryTxProposalCreateSchema", () => {
  it("accepts a payload with the canonical treasuryId", () => {
    const result = treasuryTxProposalCreateSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.treasuryId).toBe("treasury_1");
  });

  it("accepts the legacy groupId name and normalises it to treasuryId", () => {
    const result = treasuryTxProposalCreateSchema.safeParse({
      groupId: "group_legacy",
      xdr: validXdr(),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.treasuryId).toBe("group_legacy");
  });

  it("prefers treasuryId when both names are supplied", () => {
    const result = treasuryTxProposalCreateSchema.safeParse({
      treasuryId: "treasury_canonical",
      groupId: "group_legacy",
      xdr: validXdr(),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.treasuryId).toBe("treasury_canonical");
  });

  it("rejects a payload with no treasury id at all", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse({ xdr: validXdr() }).success
    ).toBe(false);
  });

  it("rejects an empty treasury id", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse({ treasuryId: "", xdr: validXdr() })
        .success
    ).toBe(false);
  });

  it("rejects a payload without an xdr", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse({ treasuryId: "t1" }).success
    ).toBe(false);
  });

  it("rejects a malformed xdr", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse({ treasuryId: "t1", xdr: "garbage!!" })
        .success
    ).toBe(false);
  });

  it("accepts an optional description within bounds", () => {
    const result = treasuryTxProposalCreateSchema.safeParse(
      validPayload({ description: "Pay March rent for the shared apartment" })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.description).toBe("Pay March rent for the shared apartment");
    }
  });

  it("accepts a payload without a description", () => {
    expect(treasuryTxProposalCreateSchema.safeParse(validPayload()).success).toBe(true);
  });

  it("rejects an empty description", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse(validPayload({ description: "" }))
        .success
    ).toBe(false);
  });

  it("rejects a description longer than 280 characters", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse(
        validPayload({ description: "x".repeat(281) })
      ).success
    ).toBe(false);
  });

  it("accepts a description of exactly 280 characters", () => {
    expect(
      treasuryTxProposalCreateSchema.safeParse(
        validPayload({ description: "x".repeat(280) })
      ).success
    ).toBe(true);
  });
});
