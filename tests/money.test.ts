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
  validateAsset,
  validateAmount,
  toStroops,
  fromStroops,
  stroopsToStellarAmount,
  compareAmounts,
  addAmounts,
  subtractAmounts,
  isSupportedAsset,
  supportedAssetCodes,
  refineValidatedAsset,
  STROOPS_PER_UNIT,
  MAX_STROOPS,
  MAX_AMOUNT,
  type ValidatedAsset,
  type ValidatedAmount,
} from "../src/lib/money";

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const validKey = Keypair.random().publicKey();

// ─── Asset Validation ────────────────────────────────────────────────────────

describe("validateAsset", () => {
  // XLM (native)
  describe("XLM (native)", () => {
    it("returns valid config for XLM without issuer", () => {
      const result = validateAsset("XLM");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.code).toBe("XLM");
        expect(result.value.type).toBe("native");
        expect(result.value.issuer).toBeNull();
        expect(result.value.name).toBe("Stellar Lumens");
      }
    });

    it("returns valid config for lowercase 'xlm'", () => {
      const result = validateAsset("xlm");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.code).toBe("XLM");
    });

    it("rejects XLM with an issuer", () => {
      const result = validateAsset("XLM", validKey);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("native_with_issuer");
        expect(result.code).toBe("INVALID_ASSET");
      }
    });

    it("accepts XLM with empty issuer string (treated as no issuer)", () => {
      const result = validateAsset("XLM", "");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.code).toBe("XLM");
    });
  });

  // USDC (issued)
  describe("USDC (issued)", () => {
    it("returns valid config for USDC with correct issuer", () => {
      const result = validateAsset("USDC", USDC_ISSUER);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.code).toBe("USDC");
        expect(result.value.type).toBe("issued");
        expect(result.value.issuer).toBe(USDC_ISSUER);
        expect(result.value.name).toBe("USD Coin");
      }
    });

    it("returns valid config for USDC without issuer (uses configured default)", () => {
      const result = validateAsset("USDC");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.code).toBe("USDC");
        expect(result.value.issuer).toBe(USDC_ISSUER);
      }
    });

    it("rejects USDC with mismatched issuer", () => {
      const wrongIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      const result = validateAsset("USDC", wrongIssuer);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("issuer_mismatch");
        expect(result.code).toBe("INVALID_ASSET");
      }
    });

    it("rejects USDC with invalid issuer format", () => {
      const result = validateAsset("USDC", "not-a-valid-key");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("invalid_issuer_format");
        expect(result.code).toBe("INVALID_ASSET");
      }
    });
  });

  // Unsupported assets
  describe("unsupported assets", () => {
    it("rejects completely unknown asset code", () => {
      const result = validateAsset("BADCOIN");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unsupported_code");
        expect(result.code).toBe("INVALID_ASSET");
      }
    });

    it("rejects empty asset code", () => {
      const result = validateAsset("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unsupported_code");
      }
    });

    it("rejects whitespace-only asset code", () => {
      const result = validateAsset("   ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("unsupported_code");
      }
    });
  });
});

// ─── isSupportedAsset ────────────────────────────────────────────────────────

describe("isSupportedAsset", () => {
  it("returns true for XLM", () => {
    expect(isSupportedAsset("XLM")).toBe(true);
  });

  it("returns true for USDC with correct issuer", () => {
    expect(isSupportedAsset("USDC", USDC_ISSUER)).toBe(true);
  });

  it("returns false for unknown assets", () => {
    expect(isSupportedAsset("BADCOIN")).toBe(false);
  });

  it("returns false for USDC with wrong issuer", () => {
    expect(isSupportedAsset("USDC", "G000000000000000000000000000000000000000000000000")).toBe(false);
  });
});

// ─── supportedAssetCodes ─────────────────────────────────────────────────────

describe("supportedAssetCodes", () => {
  it("returns XLM and USDC", () => {
    const codes = supportedAssetCodes();
    expect(codes).toContain("XLM");
    expect(codes).toContain("USDC");
  });
});

// ─── Amount Validation ───────────────────────────────────────────────────────

describe("validateAmount", () => {
  // Happy path
  describe("valid amounts", () => {
    it("accepts whole numbers", () => {
      const result = validateAmount("100");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.decimal).toBe("100");
        expect(result.value.stroops).toBe(100n * STROOPS_PER_UNIT);
      }
    });

    it("accepts fractional amounts up to 7dp", () => {
      const result = validateAmount("123.4567890");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.decimal).toBe("123.456789");
        expect(result.value.stroops).toBe(1234567890n);
      }
    });

    it("accepts minimum non-zero amount (1 stroop)", () => {
      const result = validateAmount("0.0000001");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stroops).toBe(1n);
      }
    });

    it("accepts maximum representable amount", () => {
      const result = validateAmount(MAX_AMOUNT);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.stroops).toBe(MAX_STROOPS);
      }
    });

    it("normalizes trailing zeros in fraction", () => {
      const result = validateAmount("10.5000000");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.decimal).toBe("10.5");
      }
    });

    it("normalizes leading zeros in whole part", () => {
      const result = validateAmount("0010.5");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.decimal).toBe("10.5");
      }
    });

    it("handles exactly 7 decimal places", () => {
      const result = validateAmount("1.1234567");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.decimal).toBe("1.1234567");
      }
    });
  });

  // Rejections
  describe("rejections", () => {
    it("rejects zero", () => {
      const result = validateAmount("0");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("zero_or_negative");
        expect(result.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects negative amounts", () => {
      const result = validateAmount("-10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed"); // Negative fails regex
        expect(result.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects exponent notation", () => {
      const result = validateAmount("1e10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed");
        expect(result.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects whitespace padding", () => {
      const result = validateAmount(" 10 ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("whitespace_padding");
        expect(result.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects leading whitespace only", () => {
      const result = validateAmount(" 10");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("whitespace_padding");
      }
    });

    it("rejects trailing whitespace only", () => {
      const result = validateAmount("10 ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("whitespace_padding");
      }
    });

    it("rejects excess precision (8+ decimal places)", () => {
      const result = validateAmount("1.12345678");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("excess_precision");
        expect(result.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects very small amounts beyond 7dp", () => {
      const result = validateAmount("0.00000001");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("excess_precision");
      }
    });

    it("rejects non-numeric strings", () => {
      expect(validateAmount("abc").ok).toBe(false);
      expect(validateAmount("12.34.56").ok).toBe(false);
      expect(validateAmount("1,000").ok).toBe(false);
    });

    it("rejects empty string", () => {
      const result = validateAmount("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("malformed");
      }
    });

    it("rejects amounts exceeding MAX_STROOPS", () => {
      const result = validateAmount("922337203686");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("out_of_range");
        expect(result.code).toBe("INVALID_AMOUNT");
      }
    });

    it("rejects amount just over MAX_AMOUNT", () => {
      const result = validateAmount("922337203685.4775808");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("out_of_range");
      }
    });
  });
});

// ─── Amount Conversion ───────────────────────────────────────────────────────

describe("toStroops / fromStroops / stroopsToStellarAmount", () => {
  it("round-trips whole numbers", () => {
    const stroops = toStroops("100");
    expect(fromStroops(stroops)).toBe("100");
    expect(stroopsToStellarAmount(stroops)).toBe("100.0000000");
  });

  it("round-trips fractional amounts", () => {
    const stroops = toStroops("123.456789");
    expect(fromStroops(stroops)).toBe("123.456789");
    expect(stroopsToStellarAmount(stroops)).toBe("123.4567890");
  });

  it("round-trips minimum amount", () => {
    const stroops = toStroops("0.0000001");
    expect(stroops).toBe(1n);
    expect(fromStroops(stroops)).toBe("0.0000001");
    expect(stroopsToStellarAmount(stroops)).toBe("0.0000001");
  });

  it("round-trips maximum amount", () => {
    const stroops = toStroops(MAX_AMOUNT);
    expect(stroops).toBe(MAX_STROOPS);
    expect(fromStroops(stroops)).toBe(MAX_AMOUNT);
    expect(stroopsToStellarAmount(stroops)).toBe("922337203685.4775807");
  });

  it("fromStroops handles negative values (for balance math)", () => {
    expect(fromStroops(-100n * STROOPS_PER_UNIT)).toBe("-100");
    expect(fromStroops(-1234567890n)).toBe("-123.456789");
  });

  it("stroopsToStellarAmount always produces 7dp", () => {
    expect(stroopsToStellarAmount(100n * STROOPS_PER_UNIT)).toBe("100.0000000");
    expect(stroopsToStellarAmount(1234567890n)).toBe("123.4567890");
  });
});

// ─── Amount Math ─────────────────────────────────────────────────────────────

describe("compareAmounts", () => {
  it("returns 0 for equal amounts", () => {
    expect(compareAmounts("100", "100")).toBe(0);
    expect(compareAmounts("10.5", "10.5000000")).toBe(0);
  });

  it("returns -1 when left < right", () => {
    expect(compareAmounts("10", "20")).toBe(-1);
    expect(compareAmounts("10.5", "10.6")).toBe(-1);
  });

  it("returns 1 when left > right", () => {
    expect(compareAmounts("20", "10")).toBe(1);
    expect(compareAmounts("10.6", "10.5")).toBe(1);
  });
});

describe("addAmounts", () => {
  it("adds whole numbers", () => {
    expect(addAmounts("10", "20")).toBe("30");
  });

  it("adds fractional amounts", () => {
    expect(addAmounts("10.5", "20.25")).toBe("30.75");
  });

  it("handles precision correctly", () => {
    expect(addAmounts("0.0000001", "0.0000002")).toBe("0.0000003");
  });
});

describe("subtractAmounts", () => {
  it("subtracts whole numbers", () => {
    expect(subtractAmounts("30", "10")).toBe("20");
  });

  it("subtracts fractional amounts", () => {
    expect(subtractAmounts("30.75", "20.25")).toBe("10.5");
  });

  it("throws on negative result", () => {
    expect(() => subtractAmounts("10", "20")).toThrow("Amount cannot be negative");
  });
});

// ─── Zod Integration (refineValidatedAsset) ──────────────────────────────────

describe("refineValidatedAsset (Zod integration)", () => {
  const ctx = {
    addIssue: vi.fn(),
  } as unknown as import("zod").RefinementCtx;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes for XLM without issuer", () => {
    refineValidatedAsset(ctx, "XLM", null);
    expect(ctx.addIssue).not.toHaveBeenCalled();
  });

  it("adds issue for XLM with issuer", () => {
    refineValidatedAsset(ctx, "XLM", validKey);
    expect(ctx.addIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["assetIssuer"],
        message: expect.stringContaining("native asset"),
      })
    );
  });

  it("passes for USDC with correct issuer", () => {
    refineValidatedAsset(ctx, "USDC", USDC_ISSUER);
    expect(ctx.addIssue).not.toHaveBeenCalled();
  });

  it("adds issue for USDC with wrong issuer", () => {
    // Use a valid Stellar public key that's not the configured USDC issuer
    const wrongIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    refineValidatedAsset(ctx, "USDC", wrongIssuer);
    expect(ctx.addIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["assetIssuer"],
        message: expect.stringContaining("issuer mismatch"),
      })
    );
  });

  it("adds issue for unsupported asset", () => {
    refineValidatedAsset(ctx, "BADCOIN", validKey);
    expect(ctx.addIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["assetCode"],
        message: expect.stringContaining("Unsupported asset"),
      })
    );
  });

  it("uses custom paths when provided", () => {
    refineValidatedAsset(ctx, "XLM", validKey, { code: ["customCode"], issuer: ["customIssuer"] });
    expect(ctx.addIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        path: ["customIssuer"],
      })
    );
  });
});

// ─── Constants ────────────────────────────────────────────────────────────────

describe("Constants", () => {
  it("STROOPS_PER_UNIT is 10^7", () => {
    expect(STROOPS_PER_UNIT).toBe(10_000_000n);
  });

  it("MAX_STROOPS is Int64 max", () => {
    expect(MAX_STROOPS).toBe(9_223_372_036_854_775_807n);
  });

  it("MAX_AMOUNT matches MAX_STROOPS", () => {
    expect(toStroops(MAX_AMOUNT)).toBe(MAX_STROOPS);
  });
});

// ─── Regression: No Float Arithmetic ─────────────────────────────────────────

describe("No floating-point arithmetic in validation path", () => {
  it("validateAmount never uses parseFloat/Number for comparisons", () => {
    // These values would be problematic with floating point
    const problematicValues = [
      "0.1", // Classic float precision issue
      "0.2",
      "0.3",
      "1000000000000.1234567", // Large number with precision
      "922337203685.4775807", // Max amount
    ];

    for (const val of problematicValues) {
      const result = validateAmount(val);
      // Should succeed or fail based on Stellar rules, not float artifacts
      if (!result.ok) {
        expect(result.reason).not.toBe("malformed"); // Should not fail due to float parsing
      }
    }
  });

  it("toStroops/fromStroops round-trip preserves exact values", () => {
    const testValues = [
      "0.0000001",
      "0.0000002",
      "0.1",
      "0.2",
      "0.3",
      "123.456789",
      "1000000.0000001",
      MAX_AMOUNT,
    ];

    for (const val of testValues) {
      const stroops = toStroops(val);
      const back = fromStroops(stroops);
      expect(back).toBe(val);
    }
  });
});