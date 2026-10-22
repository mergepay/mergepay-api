import { describe, it, expect } from "vitest";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { formatAssetIdentifier } from "../stellar";

const ISSUER = Keypair.random().publicKey();

describe("formatAssetIdentifier (issue #409)", () => {
  it("formats the native asset code as XLM", () => {
    expect(formatAssetIdentifier("XLM")).toBe("XLM");
    expect(formatAssetIdentifier("xlm")).toBe("XLM");
    expect(formatAssetIdentifier("native")).toBe("XLM");
  });

  it("formats native XLM when the issuer is omitted or empty", () => {
    expect(formatAssetIdentifier("XLM", undefined)).toBe("XLM");
    expect(formatAssetIdentifier("XLM", "")).toBe("XLM");
    expect(formatAssetIdentifier("XLM", "   ")).toBe("XLM");
  });

  it("formats an issued asset as CODE:ISSUER", () => {
    expect(formatAssetIdentifier("USDC", ISSUER)).toBe(`USDC:${ISSUER}`);
  });

  it("trims whitespace from the code and issuer", () => {
    expect(formatAssetIdentifier("  USDC  ", `  ${ISSUER}  `)).toBe(
      `USDC:${ISSUER}`
    );
  });

  it("formats Stellar SDK Asset instances", () => {
    expect(formatAssetIdentifier(Asset.native())).toBe("XLM");
    expect(formatAssetIdentifier(new Asset("USDC", ISSUER))).toBe(
      `USDC:${ISSUER}`
    );
  });

  it("rejects an empty asset code", () => {
    expect(() => formatAssetIdentifier("")).toThrow();
    expect(() => formatAssetIdentifier("   ")).toThrow();
  });

  it("rejects a non-native asset without an issuer", () => {
    expect(() => formatAssetIdentifier("USDC")).toThrow(/issuer/i);
  });
});
