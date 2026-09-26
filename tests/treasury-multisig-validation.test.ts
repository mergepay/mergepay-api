/**
 * Tests for the treasury multisig Zod validation schemas (issue #330).
 *
 * The schemas live in src/validations/treasury.ts and gate the treasury signer
 * configuration / weight-adjustment surface (see the `validate-signers` route
 * in src/routes/treasury.ts). These tests verify that well-formed signer
 * configurations pass while invalid Stellar addresses (including a private
 * key, which must never be accepted), out-of-range weights, and non-hierarchical
 * thresholds are rejected deterministically.
 */
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  treasurySignerConfigSchema,
  treasurySignersSchema,
  treasurySignerSchema,
  treasurySignerWeightSchema,
  treasuryThresholdUpdateSchema,
  type TreasurySignerConfigInput,
} from "../src/validations/treasury";

const signerA = Keypair.random().publicKey();
const signerB = Keypair.random().publicKey();
const privateKey = Keypair.random().secret();
const malformed = "not-a-key";

function validConfig(over: Partial<TreasurySignerConfigInput> = {}): TreasurySignerConfigInput {
  return {
    signers: [
      { publicKey: signerA, weight: 3 },
      { publicKey: signerB, weight: 2 },
    ],
    thresholds: { low: 1, med: 2, high: 5 },
    ...over,
  };
}

describe("treasurySignerConfigSchema", () => {
  it("accepts a valid multisig signer configuration", () => {
    const result = treasurySignerConfigSchema.safeParse(validConfig());
    expect(result.success).toBe(true);
  });

  it("accepts a single-signer (weight-1) configuration", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({
        signers: [{ publicKey: signerA, weight: 1 }],
        thresholds: { low: 1, med: 1, high: 1 },
      })
    );
    expect(result.success).toBe(true);
  });

  it("rejects a signer public key that is not a Stellar G-address", () => {
    for (const key of [malformed, privateKey]) {
      const result = treasurySignerConfigSchema.safeParse(
        validConfig({ signers: [{ publicKey: key, weight: 1 }] })
      );
      expect(result.success).toBe(false);
    }
  });

  it("rejects a negative signer weight", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({ signers: [{ publicKey: signerA, weight: -1 }] })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a signer weight above 255", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({ signers: [{ publicKey: signerA, weight: 256 }] })
    );
    expect(result.success).toBe(false);
  });

  it("rejects a fractional signer weight", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({ signers: [{ publicKey: signerA, weight: 1.5 }] })
    );
    expect(result.success).toBe(false);
  });

  it("rejects an empty signer roster", () => {
    const result = treasurySignerConfigSchema.safeParse(validConfig({ signers: [] }));
    expect(result.success).toBe(false);
  });

  it("rejects a negative threshold", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({ thresholds: { low: -1, med: 1, high: 2 } })
    );
    expect(result.success).toBe(false);
  });

  it("rejects thresholds that are not hierarchical (low > med)", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({ thresholds: { low: 5, med: 2, high: 5 } })
    );
    expect(result.success).toBe(false);
  });

  it("rejects thresholds where med > high", () => {
    const result = treasurySignerConfigSchema.safeParse(
      validConfig({ thresholds: { low: 1, med: 5, high: 2 } })
    );
    expect(result.success).toBe(false);
  });
});

describe("treasurySignersSchema", () => {
  it("bounds the roster to at most 20 signers", () => {
    const many: { publicKey: string; weight: number }[] = Array.from(
      { length: 21 },
      (_, i) => ({ publicKey: Keypair.random().publicKey(), weight: 1 })
    );
    expect(treasurySignersSchema.safeParse(many).success).toBe(false);
    expect(treasurySignersSchema.safeParse(many.slice(0, 20)).success).toBe(true);
  });
});

describe("treasurySignerSchema / treasurySignerWeightSchema", () => {
  it("accepts a single valid { publicKey, weight } and rejects bad weights", () => {
    expect(treasurySignerSchema.safeParse({ publicKey: signerA, weight: 10 }).success).toBe(true);
    expect(treasurySignerSchema.safeParse({ publicKey: signerA, weight: 256 }).success).toBe(false);
    expect(treasurySignerSchema.safeParse({ publicKey: privateKey, weight: 1 }).success).toBe(false);
    expect(treasurySignerWeightSchema.safeParse({ publicKey: signerA, weight: 0 }).success).toBe(true);
  });
});

describe("treasuryThresholdUpdateSchema", () => {
  it("accepts a valid threshold + requiredSigners update", () => {
    const result = treasuryThresholdUpdateSchema.safeParse({
      thresholds: { low: 1, med: 2, high: 5 },
      requiredSigners: 3,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid requiredSigners (beyond 255)", () => {
    const result = treasuryThresholdUpdateSchema.safeParse({
      thresholds: { low: 1, med: 2, high: 5 },
      requiredSigners: 300,
    });
    expect(result.success).toBe(false);
  });
});