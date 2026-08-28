import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  parseStellarAmount,
  stellarAmountSchema,
  stellarPublicKeySchema,
  stellarAssetSchema,
  MAX_STROOPS,
} from "../src/lib/stellar-validation";
import { config } from "../src/config";

describe("stellarPublicKeySchema", () => {
  it("accepts a real ed25519 public key", () => {
    const key = Keypair.random().publicKey();
    expect(stellarPublicKeySchema.safeParse(key).success).toBe(true);
  });

  it("rejects a malformed key (bad checksum)", () => {
    const key = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    expect(stellarPublicKeySchema.safeParse(key).success).toBe(false);
  });

  it("rejects a secret seed used where a public key is expected", () => {
    const seed = Keypair.random().secret();
    expect(stellarPublicKeySchema.safeParse(seed).success).toBe(false);
  });

  it("rejects garbage input", () => {
    expect(stellarPublicKeySchema.safeParse("not-a-key").success).toBe(false);
    expect(stellarPublicKeySchema.safeParse("").success).toBe(false);
  });
});

describe("parseStellarAmount / stellarAmountSchema", () => {
  it("accepts whole and fractional decimal amounts", () => {
    expect(parseStellarAmount("10")).toBe(100_000_000n);
    expect(parseStellarAmount("12.5000000")).toBe(125_000_000n);
    expect(parseStellarAmount("0.0000001")).toBe(1n);
  });

  it("rejects zero", () => {
    expect(() => parseStellarAmount("0")).toThrow(/greater than zero/i);
    expect(stellarAmountSchema.safeParse("0").success).toBe(false);
  });

  it("rejects negative amounts", () => {
    expect(() => parseStellarAmount("-1")).toThrow();
    expect(stellarAmountSchema.safeParse("-5").success).toBe(false);
  });

  it("rejects exponent notation", () => {
    expect(() => parseStellarAmount("1e10")).toThrow();
    expect(stellarAmountSchema.safeParse("1e10").success).toBe(false);
  });

  it("rejects whitespace-padded amounts", () => {
    expect(() => parseStellarAmount(" 10 ")).toThrow();
  });

  it("rejects precision overflow beyond 7 decimal places", () => {
    expect(() => parseStellarAmount("1.12345678")).toThrow(/7-decimal|precision/i);
    expect(stellarAmountSchema.safeParse("1.12345678").success).toBe(false);
  });

  it("accepts exactly 7 decimal places", () => {
    expect(() => parseStellarAmount("1.1234567")).not.toThrow();
  });

  it("accepts the maximum representable Stellar amount", () => {
    const maxAmount = "922337203685.4775807";
    expect(parseStellarAmount(maxAmount)).toBe(MAX_STROOPS);
  });

  it("rejects amounts beyond the maximum representable Stellar value", () => {
    expect(() => parseStellarAmount("922337203686")).toThrow(/exceeds/i);
    expect(stellarAmountSchema.safeParse("922337203686").success).toBe(false);
  });

  it("rejects non-numeric garbage", () => {
    expect(stellarAmountSchema.safeParse("abc").success).toBe(false);
    expect(stellarAmountSchema.safeParse("1,000").success).toBe(false);
    expect(stellarAmountSchema.safeParse("1.2.3").success).toBe(false);
  });
});

describe("stellarAssetSchema", () => {
  it("accepts XLM without an issuer", () => {
    const result = stellarAssetSchema.safeParse({ assetCode: "XLM", assetIssuer: null });
    expect(result.success).toBe(true);
  });

  it("rejects XLM with an issuer", () => {
    const result = stellarAssetSchema.safeParse({
      assetCode: "XLM",
      assetIssuer: "GDNONYVXHZ2VBTNSGKA7BUXQCB5EOSKUYX6ZBQMFXRFQKZO3H3ITNSGO",
    });
    expect(result.success).toBe(false);
  });

  it("accepts the stablecoin with the configured issuer", () => {
    const result = stellarAssetSchema.safeParse({
      assetCode: config.STABLE_ASSET_CODE,
      assetIssuer: config.STABLE_ASSET_ISSUER,
    });
    expect(result.success).toBe(true);
  });

  it("rejects the stablecoin with a wrong/incorrect issuer", () => {
    const result = stellarAssetSchema.safeParse({
      assetCode: config.STABLE_ASSET_CODE,
      assetIssuer: "GDNONYVXHZ2VBTNSGKA7BUXQCB5EOSKUYX6ZBQMFXRFQKZO3H3ITNSGO",
    });
    expect(result.success).toBe(false);
  });

  it("accepts the stablecoin with no issuer (uses configured default)", () => {
    const result = stellarAssetSchema.safeParse({
      assetCode: config.STABLE_ASSET_CODE,
      assetIssuer: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unsupported asset codes", () => {
    const result = stellarAssetSchema.safeParse({
      assetCode: "SHITCOIN",
      assetIssuer: "GDNONYVXHZ2VBTNSGKA7BUXQCB5EOSKUYX6ZBQMFXRFQKZO3H3ITNSGO",
    });
    expect(result.success).toBe(false);
  });
});
