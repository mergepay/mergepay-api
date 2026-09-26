import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import {
  ASSET_CODE_MAX_LENGTH,
  assetCodeSchema,
  assetIssuerSchema,
  assetQuerySchema,
} from "../../src/schemas/asset";

const VALID_ISSUER = Keypair.random().publicKey();
const OTHER_ISSUER = Keypair.random().publicKey();

function issueFor(result: ReturnType<typeof assetQuerySchema.safeParse>, path: string[]) {
  if (result.success) return undefined;
  return result.error.issues.find((issue) => issue.path.join(".") === path.join("."));
}

describe("assetCodeSchema", () => {
  it("accepts the native XLM asset code", () => {
    const result = assetCodeSchema.safeParse("XLM");
    expect(result.success).toBe(true);
  });

  it("accepts a valid custom asset code", () => {
    const result = assetCodeSchema.safeParse("USDC");
    expect(result.success).toBe(true);
  });

  it("accepts a 1-character and a maximum-length asset code", () => {
    expect(assetCodeSchema.safeParse("A").success).toBe(true);
    expect(
      assetCodeSchema.safeParse("A".repeat(ASSET_CODE_MAX_LENGTH)).success
    ).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const result = assetCodeSchema.safeParse("  USDC  ");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("USDC");
  });

  it("rejects an empty asset code", () => {
    expect(assetCodeSchema.safeParse("").success).toBe(false);
  });

  it("rejects a whitespace-only asset code", () => {
    expect(assetCodeSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects an asset code longer than 12 characters", () => {
    const result = assetCodeSchema.safeParse("A".repeat(ASSET_CODE_MAX_LENGTH + 1));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("at most 12 characters");
    }
  });

  it("rejects non-alphanumeric asset codes", () => {
    for (const code of ["US-DC", "US DC", "USD$", "USDC2!", "X L"]) {
      const result = assetCodeSchema.safeParse(code);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("letters and digits");
      }
    }
  });

  it("rejects non-string values", () => {
    expect(assetCodeSchema.safeParse(123).success).toBe(false);
    expect(assetCodeSchema.safeParse(undefined).success).toBe(false);
    expect(assetCodeSchema.safeParse(null).success).toBe(false);
  });
});

describe("assetIssuerSchema", () => {
  it("accepts a valid G-address issuer public key", () => {
    const result = assetIssuerSchema.safeParse(VALID_ISSUER);
    expect(result.success).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    const result = assetIssuerSchema.safeParse(`  ${VALID_ISSUER}  `);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(VALID_ISSUER);
  });

  it("rejects an empty issuer", () => {
    expect(assetIssuerSchema.safeParse("").success).toBe(false);
  });

  it("rejects a malformed issuer key", () => {
    for (const issuer of ["not-a-key", "GSHORT", "A".repeat(56), VALID_ISSUER.slice(0, 40)]) {
      expect(assetIssuerSchema.safeParse(issuer).success).toBe(false);
    }
  });

  it("rejects a key whose checksum is corrupted", () => {
    const lastChar = VALID_ISSUER.slice(-1);
    const corrupted = `${VALID_ISSUER.slice(0, -1)}${lastChar === "A" ? "B" : "A"}`;
    expect(assetIssuerSchema.safeParse(corrupted).success).toBe(false);
  });

  it("rejects a secret (S-address) key", () => {
    expect(assetIssuerSchema.safeParse(Keypair.random().secret()).success).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(assetIssuerSchema.safeParse(undefined).success).toBe(false);
    expect(assetIssuerSchema.safeParse(null).success).toBe(false);
  });
});

describe("assetQuerySchema", () => {
  it("accepts native XLM without an issuer", () => {
    const result = assetQuerySchema.safeParse({ assetCode: "XLM" });
    expect(result.success).toBe(true);
  });

  it("accepts native XLM with an explicit null issuer", () => {
    const result = assetQuerySchema.safeParse({ assetCode: "XLM", assetIssuer: null });
    expect(result.success).toBe(true);
  });

  it("accepts a valid custom asset with its issuer", () => {
    const result = assetQuerySchema.safeParse({
      assetCode: "USDC",
      assetIssuer: VALID_ISSUER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assetCode).toBe("USDC");
      expect(result.data.assetIssuer).toBe(VALID_ISSUER);
    }
  });

  it("rejects an issuer supplied for the native asset", () => {
    const result = assetQuerySchema.safeParse({
      assetCode: "XLM",
      assetIssuer: VALID_ISSUER,
    });
    expect(result.success).toBe(false);
    expect(issueFor(result, ["assetIssuer"])?.message).toContain("native asset");
  });

  it("rejects a non-native asset without an issuer", () => {
    const result = assetQuerySchema.safeParse({ assetCode: "USDC" });
    expect(result.success).toBe(false);
    expect(issueFor(result, ["assetIssuer"])?.message).toContain("required");
  });

  it("rejects a non-native asset with a null issuer", () => {
    const result = assetQuerySchema.safeParse({
      assetCode: "USDC",
      assetIssuer: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid issuer for a custom asset", () => {
    const result = assetQuerySchema.safeParse({
      assetCode: "USDC",
      assetIssuer: "not-a-key",
    });
    expect(result.success).toBe(false);
    expect(issueFor(result, ["assetIssuer"])).toBeDefined();
  });

  it("rejects malformed asset codes even when the issuer is valid", () => {
    for (const assetCode of ["", "   ", "US-DC", "A".repeat(13)]) {
      const result = assetQuerySchema.safeParse({ assetCode, assetIssuer: OTHER_ISSUER });
      expect(result.success).toBe(false);
      expect(issueFor(result, ["assetCode"])).toBeDefined();
    }
  });

  it("accepts a lowercase custom asset code and keeps the issuer", () => {
    const result = assetQuerySchema.safeParse({
      assetCode: "usdc",
      assetIssuer: OTHER_ISSUER,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.assetIssuer).toBe(OTHER_ISSUER);
  });
});
