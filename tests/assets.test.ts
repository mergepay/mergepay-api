import { describe, it, expect, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

// Mock config before importing the module under test.
vi.mock("../src/config", () => ({
  config: {
    STABLE_ASSET_CODE: "USDC",
    STABLE_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    STELLAR_NETWORK: "public",
  },
}));

import {
  getAssetConfig,
  validateAsset,
  validateIssuer,
  validateAmount,
  validateAssetSpec,
  assetConfigToSpec,
  isSupportedAsset,
  supportedAssetCodes,
  ASSET_PRECISION,
} from "../src/services/assets";
import type { AssetConfig } from "../src/services/assets";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const validKey = Keypair.random().publicKey();

// ─── XLM (native) ──────────────────────────────────────────────────────────

describe("XLM (native)", () => {
  it("returns the correct config for XLM without issuer", () => {
    const a = getAssetConfig("XLM");
    expect(a.code).toBe("XLM");
    expect(a.type).toBe("native");
    expect(a.issuer).toBeNull();
    expect(a.name).toBe("Stellar Lumens");
  });

  it("returns the correct config for lowercase 'xlm'", () => {
    const a = getAssetConfig("xlm");
    expect(a.code).toBe("XLM");
    expect(a.type).toBe("native");
  });

  it("rejects XLM with an issuer (native has no issuer)", () => {
    expect(() => getAssetConfig("XLM", validKey)).toThrow(/native.*issuer/i);
  });
});

// ─── USDC (issued) ─────────────────────────────────────────────────────────

describe("USDC (issued)", () => {
  it("returns the correct config for USDC with its issuer", () => {
    const a = getAssetConfig("USDC", USDC_ISSUER);
    expect(a.code).toBe("USDC");
    expect(a.type).toBe("issued");
    expect(a.issuer).toBe(USDC_ISSUER);
    expect(a.name).toBe("USD Coin");
  });

  it("returns the configured issuer when no issuer is supplied", () => {
    const a = getAssetConfig("USDC");
    expect(a.code).toBe("USDC");
    expect(a.issuer).toBe(USDC_ISSUER);
  });

  it("rejects USDC with a mismatched issuer", () => {
    const wrongIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(() => getAssetConfig("USDC", wrongIssuer)).toThrow(/issuer mismatch/i);
  });
});

// ─── Unsupported assets ────────────────────────────────────────────────────

describe("unsupported assets", () => {
  it("rejects a completely unknown asset code", () => {
    expect(() => getAssetConfig("BADCOIN")).toThrow(/unsupported asset code/i);
  });

  it("rejects an empty asset code", () => {
    expect(() => getAssetConfig("")).toThrow(/asset code is required/i);
  });

  it("rejects a blank (whitespace) asset code", () => {
    expect(() => getAssetConfig("   ")).toThrow(/asset code is required/i);
  });
});

// ─── validateIssuer ────────────────────────────────────────────────────────

describe("validateIssuer", () => {
  it("accepts a valid Stellar public key", () => {
    expect(() => validateIssuer(validKey)).not.toThrow();
  });

  it("rejects an invalid public key", () => {
    expect(() => validateIssuer("not-a-key")).toThrow(/not a valid stellar public key/i);
  });

  it("rejects a Stellar secret key (starts with S)", () => {
    const secret = Keypair.random().secret();
    expect(() => validateIssuer(secret)).toThrow(/not a valid stellar public key/i);
  });
});

// ─── validateAmount / precision ────────────────────────────────────────────

describe("validateAmount / precision", () => {
  it("accepts a whole number", () => {
    expect(validateAmount("100")).toBe("100");
  });

  it("accepts a number with up to 7 decimal places", () => {
    expect(validateAmount("123.4567890")).toBe("123.4567890");
    expect(validateAmount("0.0000001")).toBe("0.0000001");
    expect(validateAmount("1.0000000")).toBe("1.0000000");
  });

  it("accepts a number with fewer than 7 decimal places", () => {
    expect(validateAmount("12.5")).toBe("12.5");
    expect(validateAmount("0.001")).toBe("0.001");
  });

  it("rejects a number with more than 7 decimal places", () => {
    expect(() => validateAmount("1.12345678")).toThrow(/7.*decimal/i);
    expect(() => validateAmount("0.00000001")).toThrow(/7.*decimal/i);
  });

  it("rejects zero and negative amounts", () => {
    expect(() => validateAmount("0")).toThrow(/greater than zero/);
    expect(() => validateAmount("-5")).toThrow(/not a valid numeric amount/);
  });

  it("rejects non-numeric strings", () => {
    expect(() => validateAmount("abc")).toThrow(/not a valid numeric amount/);
    expect(() => validateAmount("12.34.56")).toThrow(/not a valid numeric amount/);
  });

  it("rejects empty string", () => {
    expect(() => validateAmount("")).toThrow(/not a valid numeric amount/);
  });
});

// ─── validateAssetSpec ─────────────────────────────────────────────────────

describe("validateAssetSpec", () => {
  it("validates an AssetSpec-shaped object for XLM", () => {
    const a = validateAssetSpec({ code: "XLM", issuer: null });
    expect(a.code).toBe("XLM");
    expect(a.type).toBe("native");
  });

  it("validates an AssetSpec-shaped object for USDC", () => {
    const a = validateAssetSpec({ code: "USDC", issuer: USDC_ISSUER });
    expect(a.code).toBe("USDC");
    expect(a.type).toBe("issued");
  });

  it("rejects unsupported assets in AssetSpec", () => {
    expect(() => validateAssetSpec({ code: "BAD" })).toThrow(/unsupported/i);
  });
});

// ─── assetConfigToSpec ─────────────────────────────────────────────────────

describe("assetConfigToSpec", () => {
  it("converts a native asset to AssetSpec", () => {
    const config: AssetConfig = {
      code: "XLM",
      type: "native",
      issuer: null,
      name: "Stellar Lumens",
    };
    expect(assetConfigToSpec(config)).toEqual({ code: "XLM", issuer: null });
  });

  it("converts an issued asset to AssetSpec", () => {
    const config: AssetConfig = {
      code: "USDC",
      type: "issued",
      issuer: "GABCDEF...",
      name: "USD Coin",
    };
    expect(assetConfigToSpec(config)).toEqual({ code: "USDC", issuer: "GABCDEF..." });
  });
});

// ─── isSupportedAsset ──────────────────────────────────────────────────────

describe("isSupportedAsset", () => {
  it("returns true for XLM", () => {
    expect(isSupportedAsset("XLM")).toBe(true);
  });

  it("returns true for USDC with correct issuer", () => {
    expect(isSupportedAsset("USDC", USDC_ISSUER)).toBe(true);
  });

  it("returns false for unknown assets (no throw)", () => {
    expect(isSupportedAsset("BADCOIN")).toBe(false);
  });

  it("returns false for USDC with wrong issuer (no throw)", () => {
    expect(isSupportedAsset("USDC", "G000000000000000000000000000000000000000000000000")).toBe(false);
  });
});

// ─── supportedAssetCodes ───────────────────────────────────────────────────

describe("supportedAssetCodes", () => {
  it("returns XLM and USDC", () => {
    const codes = supportedAssetCodes();
    expect(codes).toContain("XLM");
    expect(codes).toContain("USDC");
  });
});

// ─── ASSET_PRECISION ───────────────────────────────────────────────────────

describe("ASSET_PRECISION", () => {
  it("is 7 (Stellar standard)", () => {
    expect(ASSET_PRECISION).toBe(7);
  });
});

// ─── validateAsset convenience wrapper ─────────────────────────────────────

describe("validateAsset", () => {
  it("calls validateIssuer when issuer is provided", () => {
    expect(() => validateAsset("USDC", "not-a-key")).toThrow(/not a valid stellar public key/i);
  });

  it("passes through to getAssetConfig on success", () => {
    const a = validateAsset("XLM");
    expect(a.code).toBe("XLM");
  });
});
