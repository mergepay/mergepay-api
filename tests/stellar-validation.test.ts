/**
 * Comprehensive unit tests for the shared Zod schemas validating Stellar
 * account IDs and memo formats (issue #425).
 *
 * Units under test live in `src/lib/stellar-validation.ts` and are the
 * single gate used before building unsigned XDR transactions and before
 * accepting recipient / destination fields from clients — so a regression
 * here would let a malformed G-address or memo reach the settlement engine
 * or Horizon. The companion transaction-memo parser lives in `src/lib/memo.ts`
 * (`parseMemo` / `validatePaymentMemo`) and is exercised in `tests/memo.test.ts`,
 * `tests/memo-format.test.ts`, `tests/payment-memo.test.ts` and
 * `src/utils/__tests__/memo.test.ts`; the Zod schema `mpMemoSchema` is
 * intentionally looser (prefix + 28-byte ceiling only) and is tested here
 * against its own contract so Zod rejections stay aligned with the parser.
 *
 * Coverage goals for this file:
 *  1. Valid Stellar public keys (G-addresses) are accepted by both
 *     `stellarAccountIdSchema` and its alias `stellarPublicKeySchema`.
 *  2. Every invalid class is rejected with a descriptive issue before any
 *     Horizon / DB I/O could happen: wrong length, bad checksum, wrong
 *     prefix (seed / muxed), non-StrKey strings, whitespace-padded, empty,
 *     and non-string inputs.
 *  3. Valid `MP:` memos pass `mpMemoSchema` and invalid ones fail, with a
 *     focus on the Stellar `MEMO_TEXT` byte limit (28 UTF-8 bytes) and the
 *     exact `MP:` prefix — both as Zod and, for context, compared to the
 *     stricter `parseMemo` alphabet where it differs.
 */
import { describe, it, expect } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import {
  parseStellarAmount,
  stellarAmountSchema,
  stellarAccountIdSchema,
  stellarPublicKeySchema,
  mpMemoSchema,
  stellarAssetSchema,
  MAX_STROOPS,
} from "../src/lib/stellar-validation";
import { parseMemo } from "../src/lib/memo";
import { config } from "../src/config";

/** Flip the last character of a valid public key so the checksum fails but the length stays 56. */
function checksumBrokenKey(): string {
  const key = Keypair.random().publicKey();
  const last = key.slice(-1);
  return key.slice(0, -1) + (last === "A" ? "B" : "A");
}

// ─── Stellar account ID ────────────────────────────────────────────────────

describe("stellarPublicKeySchema / stellarAccountIdSchema — Stellar account IDs (G-addresses)", () => {
  describe("valid public keys", () => {
    it("accepts a real ed25519 public key", () => {
      const key = Keypair.random().publicKey();
      expect(stellarPublicKeySchema.safeParse(key).success).toBe(true);
      expect(stellarAccountIdSchema.safeParse(key).success).toBe(true);
    });

    it("accepts many distinct random public keys and confirms StrKey validity", () => {
      for (let i = 0; i < 10; i++) {
        const key = Keypair.random().publicKey();
        expect(StrKey.isValidEd25519PublicKey(key)).toBe(true);
        expect(stellarPublicKeySchema.safeParse(key).success).toBe(true);
        expect(stellarAccountIdSchema.safeParse(key).success).toBe(true);
        expect(key).toMatch(/^G[A-Z2-7]{55}$/);
        expect(key).toHaveLength(56);
      }
    });

    it("stellarPublicKeySchema and stellarAccountIdSchema agree on every valid key", () => {
      const key = Keypair.random().publicKey();
      expect(stellarPublicKeySchema.safeParse(key).success).toBe(
        stellarAccountIdSchema.safeParse(key).success
      );
    });
  });

  describe("invalid public keys", () => {
    it("rejects lowercase, wrong-length, or non-StrKey strings", () => {
      expect(
        stellarAccountIdSchema.safeParse("gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
          .success
      ).toBe(false);
      expect(
        stellarAccountIdSchema.safeParse("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
          .success
      ).toBe(false);
      expect(stellarAccountIdSchema.safeParse("not-a-key").success).toBe(false);
    });

    it("rejects a secret seed used where a public key is expected", () => {
      const seed = Keypair.random().secret();
      expect(seed).toMatch(/^S[A-Z2-7]{55}$/);
      expect(stellarPublicKeySchema.safeParse(seed).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(seed).success).toBe(false);
    });

    it("rejects garbage and empty input", () => {
      expect(stellarPublicKeySchema.safeParse("not-a-key").success).toBe(false);
      expect(stellarPublicKeySchema.safeParse("").success).toBe(false);
      expect(stellarAccountIdSchema.safeParse("").success).toBe(false);
      expect(stellarAccountIdSchema.safeParse("   ").success).toBe(false);
    });

    it("rejects non-string inputs", () => {
      expect(stellarAccountIdSchema.safeParse(null as unknown as string).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(undefined as unknown as string).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(123 as unknown as string).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse({} as unknown as string).success).toBe(false);
      expect(stellarPublicKeySchema.safeParse(null as unknown as string).success).toBe(false);
    });

    it("rejects a full-length key whose checksum has been broken", () => {
      const broken = checksumBrokenKey();
      expect(broken).toHaveLength(56);
      expect(broken.startsWith("G")).toBe(true);
      expect(StrKey.isValidEd25519PublicKey(broken)).toBe(false);
      expect(stellarAccountIdSchema.safeParse(broken).success).toBe(false);
      expect(stellarPublicKeySchema.safeParse(broken).success).toBe(false);
    });

    it("rejects keys with whitespace padding (must be exact G-address)", () => {
      const key = Keypair.random().publicKey();
      expect(stellarAccountIdSchema.safeParse(` ${key}`).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(`${key} `).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(`\n${key}\n`).success).toBe(false);
    });

    it("rejects too-short and too-long strings", () => {
      const key = Keypair.random().publicKey();
      expect(stellarAccountIdSchema.safeParse(key.slice(0, 55)).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(`${key}A`).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse("G".repeat(56)).success).toBe(false); // correct length but bad checksum
    });

    it("rejects muxed accounts (M-addresses) and other prefixes", () => {
      // M-addresses are not ed25519 public keys — StrKey rejects them as G-addresses.
      // We assert the schema follows StrKey rather than hard-coding a sample.
      const key = Keypair.random().publicKey();
      const muxedLike = `M${key.slice(1)}`;
      if (!StrKey.isValidEd25519PublicKey(muxedLike)) {
        expect(stellarAccountIdSchema.safeParse(muxedLike).success).toBe(false);
      }
      expect(stellarAccountIdSchema.safeParse(`S${key.slice(1)}`).success).toBe(false);
      expect(stellarAccountIdSchema.safeParse(`T${key.slice(1)}`).success).toBe(false);
    });

    it("rejects non-base32 characters and embedded separators", () => {
      expect(stellarAccountIdSchema.safeParse("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0").success).toBe(false);
      expect(stellarAccountIdSchema.safeParse("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA!").success).toBe(false);
      expect(stellarAccountIdSchema.safeParse("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-AAAAAAAAAAAAAAAA").success).toBe(false);
    });

    it("surfaces a descriptive validation message", () => {
      const result = stellarAccountIdSchema.safeParse("not-a-key");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toMatch(/Invalid Stellar account ID/i);
      }
    });
  });
});

// ─── Mergepay MP: memos (mpMemoSchema) ─────────────────────────────────────

describe("mpMemoSchema — MP: memo format", () => {
  describe("valid memos", () => {
    it("accepts valid Mergepay memos with the MP: prefix", () => {
      expect(mpMemoSchema.safeParse("MP:ABC123").success).toBe(true);
      expect(mpMemoSchema.safeParse("MP:hello").success).toBe(true);
    });

    it("accepts a minimal memo with a single character after MP:", () => {
      expect(mpMemoSchema.safeParse("MP:A").success).toBe(true);
      expect(mpMemoSchema.safeParse("MP:9").success).toBe(true);
      expect(mpMemoSchema.safeParse("MP:x").success).toBe(true);
    });

    it("accepts lowercase / mixed-case payloads (schema is prefix + byte-length only; alphabet is enforced by parseMemo)", () => {
      expect(mpMemoSchema.safeParse("MP:hello").success).toBe(true);
      expect(mpMemoSchema.safeParse("MP:AbC123").success).toBe(true);
      // The stricter lib/memo parser would reject these — the schema deliberately does not.
      expect(parseMemo("MP:hello").ok).toBe(false);
    });

    it("rejects memos without the MP: prefix", () => {
      expect(mpMemoSchema.safeParse("ABC123").success).toBe(false);
      expect(mpMemoSchema.safeParse("hello").success).toBe(false);
    });

    it("rejects memos that exceed the Stellar MEMO_TEXT UTF-8 byte limit", () => {
      const tooLong = "MP:" + "é".repeat(15);
      expect(Buffer.byteLength(tooLong, "utf8")).toBeGreaterThan(28);
      expect(mpMemoSchema.safeParse(tooLong).success).toBe(false);
    });

    it("accepts values at the exact 28-byte boundary", () => {
      const exact = "MP:" + "a".repeat(25);
      expect(Buffer.byteLength(exact, "utf8")).toBe(28);
      expect(mpMemoSchema.safeParse(exact).success).toBe(true);
    });

    it("accepts values just under the 28-byte boundary", () => {
      const under = "MP:" + "a".repeat(24);
      expect(Buffer.byteLength(under, "utf8")).toBe(27);
      expect(mpMemoSchema.safeParse(under).success).toBe(true);
    });

    it("rejects a memo one byte over the limit with pure ASCII", () => {
      const over = "MP:" + "A".repeat(26); // 3 + 26 = 29 bytes
      expect(Buffer.byteLength(over, "utf8")).toBe(29);
      expect(mpMemoSchema.safeParse(over).success).toBe(false);
    });

    it("enforces the byte limit correctly for multibyte UTF-8 characters", () => {
      // 'é' is 2 bytes in UTF-8.
      const atLimit = "MP:" + "é".repeat(12) + "a"; // 3 + 24 + 1 = 28
      const overLimit = "MP:" + "é".repeat(13); // 3 + 26 = 29
      expect(Buffer.byteLength(atLimit, "utf8")).toBe(28);
      expect(mpMemoSchema.safeParse(atLimit).success).toBe(true);
      expect(Buffer.byteLength(overLimit, "utf8")).toBeGreaterThan(28);
      expect(mpMemoSchema.safeParse(overLimit).success).toBe(false);
    });

    it("accepts MP: with exactly 25 characters (max ASCII payload for 28-byte MEMO_TEXT)", () => {
      const maxAscii = `MP:${"Z".repeat(25)}`;
      expect(Buffer.byteLength(maxAscii, "utf8")).toBe(28);
      expect(mpMemoSchema.safeParse(maxAscii).success).toBe(true);
      // "Z" is in ALPHABET, so the stricter parseMemo also accepts it.
      expect(parseMemo(maxAscii).ok).toBe(true);
    });
  });

  describe("invalid memos", () => {
    it("rejects an empty string and whitespace", () => {
      expect(mpMemoSchema.safeParse("").success).toBe(false);
      expect(mpMemoSchema.safeParse("   ").success).toBe(false);
    });

    it("rejects lowercase and wrong prefixes", () => {
      expect(mpMemoSchema.safeParse("mp:ABC123").success).toBe(false);
      expect(mpMemoSchema.safeParse("Mp:ABC123").success).toBe(false);
      expect(mpMemoSchema.safeParse("MP-ABC123").success).toBe(false);
      expect(mpMemoSchema.safeParse(" MP:ABC123").success).toBe(false);
      expect(mpMemoSchema.safeParse("XP:ABC123").success).toBe(false);
      expect(mpMemoSchema.safeParse("M:ABC123").success).toBe(false);
    });

    it("rejects non-string inputs", () => {
      expect(mpMemoSchema.safeParse(null as unknown as string).success).toBe(false);
      expect(mpMemoSchema.safeParse(undefined as unknown as string).success).toBe(false);
      expect(mpMemoSchema.safeParse(123 as unknown as string).success).toBe(false);
      expect(mpMemoSchema.safeParse({} as unknown as string).success).toBe(false);
    });

    it("notes that MP: alone (no code) passes this schema but fails the stricter parseMemo — documents the intentional layering", () => {
      expect(mpMemoSchema.safeParse("MP:").success).toBe(true);
      expect(parseMemo("MP:").ok).toBe(false);
    });

    it("rejects a memo that would overflow due to multibyte characters even when char count is small", () => {
      // 15 'é' chars = 30 bytes + 3 prefix = 33 bytes > 28, even though only 15 chars.
      const multiByte = "MP:" + "é".repeat(15);
      expect(multiByte.length).toBe(18);
      expect(Buffer.byteLength(multiByte, "utf8")).toBeGreaterThan(28);
      expect(mpMemoSchema.safeParse(multiByte).success).toBe(false);
    });

    it("surfaces descriptive messages for the two failure modes", () => {
      const prefixFail = mpMemoSchema.safeParse("nope");
      expect(prefixFail.success).toBe(false);
      if (!prefixFail.success) {
        expect(prefixFail.error.issues[0]?.message).toMatch(/MP:/);
      }
      const byteFail = mpMemoSchema.safeParse("MP:" + "é".repeat(15));
      expect(byteFail.success).toBe(false);
      if (!byteFail.success) {
        expect(byteFail.error.issues[0]?.message).toMatch(/28 UTF-8 bytes/i);
      }
    });
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
