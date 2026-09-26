import { describe, it, expect } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import { formatAssetIdentifier, parseAssetIdentifier } from "../src/utils/stellar";

describe("formatAssetIdentifier", () => {
  const testIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  describe("Native asset formatting", () => {
    it("formats Asset.native() instance as 'native'", () => {
      const nativeAsset = Asset.native();
      expect(formatAssetIdentifier(nativeAsset)).toBe("native");
    });

    it("formats object with code 'native' as 'native'", () => {
      expect(formatAssetIdentifier({ code: "native" })).toBe("native");
    });

    it("formats object with code 'XLM' as 'native'", () => {
      expect(formatAssetIdentifier({ code: "XLM" })).toBe("native");
      expect(formatAssetIdentifier({ code: "xlm" })).toBe("native");
    });

    it("formats string 'native' as 'native'", () => {
      expect(formatAssetIdentifier("native")).toBe("native");
      expect(formatAssetIdentifier("NATIVE")).toBe("native");
      expect(formatAssetIdentifier("  native  ")).toBe("native");
    });

    it("formats string 'XLM' as 'native' when no issuer provided", () => {
      expect(formatAssetIdentifier("XLM")).toBe("native");
      expect(formatAssetIdentifier("xlm")).toBe("native");
    });
  });

  describe("Issued credit asset formatting", () => {
    it("formats Stellar SDK Asset instance as 'code:issuer'", () => {
      const usdcAsset = new Asset("USDC", testIssuer);
      expect(formatAssetIdentifier(usdcAsset)).toBe(`USDC:${testIssuer}`);
    });

    it("formats object with code and issuer as 'code:issuer'", () => {
      const input = { code: "USDC", issuer: testIssuer };
      expect(formatAssetIdentifier(input)).toBe(`USDC:${testIssuer}`);
    });

    it("formats string code and second-argument issuer as 'code:issuer'", () => {
      expect(formatAssetIdentifier("USDC", testIssuer)).toBe(`USDC:${testIssuer}`);
    });

    it("preserves already formatted 'code:issuer' string", () => {
      const canonical = `USDC:${testIssuer}`;
      expect(formatAssetIdentifier(canonical)).toBe(canonical);
    });

    it("trims whitespace from code and issuer strings", () => {
      expect(formatAssetIdentifier("  USDC  ", `  ${testIssuer}  `)).toBe(`USDC:${testIssuer}`);
      expect(formatAssetIdentifier(`  USDC:${testIssuer}  `)).toBe(`USDC:${testIssuer}`);
    });
  });

  describe("Validation & Error handling", () => {
    it("throws when asset input is null or undefined", () => {
      expect(() => formatAssetIdentifier(null as any)).toThrow(/required/i);
      expect(() => formatAssetIdentifier(undefined as any)).toThrow(/required/i);
      expect(() => formatAssetIdentifier("")).toThrow(/required|empty/i);
    });

    it("throws when non-native asset object has no issuer", () => {
      expect(() => formatAssetIdentifier({ code: "USDC" })).toThrow(/requires a valid issuer/i);
      expect(() => formatAssetIdentifier({ code: "USDC", issuer: "" })).toThrow(/requires a valid issuer/i);
      expect(() => formatAssetIdentifier({ code: "USDC", issuer: null })).toThrow(/requires a valid issuer/i);
    });

    it("throws when non-native asset string has no issuer", () => {
      expect(() => formatAssetIdentifier("USDC")).toThrow(/requires a valid issuer/i);
    });

    it("rejects invalid issuer public keys when formatting or parsing issued assets", () => {
      expect(() => formatAssetIdentifier({ code: "USDC", issuer: "GINVALID" })).toThrow(
        /invalid issuer public key/i
      );
      expect(() => formatAssetIdentifier("USDC:GINVALID")).toThrow(/invalid issuer public key/i);
      expect(() => parseAssetIdentifier("USDC:GINVALID")).toThrow(/invalid issuer public key/i);
    });

    it("throws on malformed colon string identifier", () => {
      expect(() => formatAssetIdentifier("USDC:")).toThrow(/invalid asset identifier/i);
      expect(() => formatAssetIdentifier(":GBBD47")).toThrow(/invalid asset identifier/i);
      expect(() => formatAssetIdentifier("USDC:ISSUER:EXTRA")).toThrow(/invalid asset identifier/i);
    });
  });
});

describe("parseAssetIdentifier", () => {
  const testIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("parses 'native' into code XLM with null issuer", () => {
    expect(parseAssetIdentifier("native")).toEqual({ code: "XLM", issuer: null });
    expect(parseAssetIdentifier("NATIVE")).toEqual({ code: "XLM", issuer: null });
    expect(parseAssetIdentifier("XLM")).toEqual({ code: "XLM", issuer: null });
  });

  it("parses 'code:issuer' string into code and issuer components", () => {
    expect(parseAssetIdentifier(`USDC:${testIssuer}`)).toEqual({
      code: "USDC",
      issuer: testIssuer,
    });
  });

  it("throws on empty or non-string identifier", () => {
    expect(() => parseAssetIdentifier("")).toThrow(/non-empty string/i);
    expect(() => parseAssetIdentifier(null as any)).toThrow(/non-empty string/i);
  });

  it("throws on non-native string missing colon separator", () => {
    expect(() => parseAssetIdentifier("USDC")).toThrow(/Expected "<code>:<issuer>"/i);
  });
});
