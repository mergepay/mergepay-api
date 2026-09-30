/**
 * Issue #506 — `validatePaymentMemo` (src/lib/memo.ts).
 *
 * The pure attribution check for an incoming settlement payment's on-chain
 * memo: only a `text` memo that parses as exactly `MP:<expectedCode>` is
 * attributed. Every other shape fails with a distinct reason and never
 * echoes the attacker-controlled memo text back.
 */
import { describe, it, expect } from "vitest";
import { validatePaymentMemo, MEMO_HASH_BYTES } from "../src/lib/memo";

const CODE = "ABC234XYZ9";
const text = (memo: string | null | undefined) => ({ memoType: "text", memo });
const hashOf = (bytes: Buffer) => ({ memoType: "hash", memo: bytes.toString("base64") });

describe("validatePaymentMemo — valid MP: memos", () => {
  it("accepts the exact expected reference", () => {
    expect(validatePaymentMemo(text(`MP:${CODE}`), CODE)).toEqual({
      ok: true,
      code: CODE,
      memo: `MP:${CODE}`,
    });
  });

  it("accepts a single-character code", () => {
    expect(validatePaymentMemo(text("MP:A"), "A")).toMatchObject({ ok: true, code: "A" });
  });

  it("accepts a code at the 28-byte MEMO_TEXT limit", () => {
    const longCode = "A".repeat(25);
    expect(validatePaymentMemo(text(`MP:${longCode}`), longCode)).toMatchObject({
      ok: true,
      code: longCode,
    });
  });
});

describe("validatePaymentMemo — missing memos", () => {
  it.each([
    ["memo_type none", { memoType: "none", memo: undefined }],
    ["memo_type absent", { memoType: undefined, memo: undefined }],
    ["memo_type null", { memoType: null, memo: null }],
    ["empty text memo", text("")],
    ["text memo with undefined value", text(undefined)],
    ["text memo with null value", text(null)],
  ])("rejects %s as missing_memo", (_label, onChain) => {
    expect(validatePaymentMemo(onChain, CODE)).toEqual({
      ok: false,
      reason: "missing_memo",
      message: "Transaction has no memo",
    });
  });
});

describe("validatePaymentMemo — malformed / non-matching text memos", () => {
  it.each([
    ["no MP: prefix", "ABC234XYZ9"],
    ["lower-case prefix", `mp:${CODE}`],
    ["prefix without colon", `MP${CODE}`],
    ["other app prefix", `XP:${CODE}`],
    ["prefix only", "MP:"],
    ["lower-case code", `MP:${CODE.toLowerCase()}`],
    ["ambiguous letter O", "MP:ABCO"],
    ["ambiguous letter I", "MP:ABCI"],
    ["digit 0", "MP:ABC0"],
    ["digit 1", "MP:ABC1"],
    ["leading whitespace", ` MP:${CODE}`],
    ["trailing whitespace", `MP:${CODE} `],
    ["trailing newline", `MP:${CODE}\n`],
    ["embedded NUL", `MP:${CODE}\u0000`],
    ["second separator", `MP:${CODE}:X`],
    ["unicode look-alike (Cyrillic A)", "MP:АBC234"],
    ["replacement char from non-UTF-8 bytes", "MP:AB�"],
    ["over 28 bytes", `MP:${"A".repeat(26)}`],
    ["free-form exchange memo", "deposit for alice"],
  ])("rejects %s as malformed_memo", (_label, memo) => {
    const result = validatePaymentMemo(text(memo), CODE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("malformed_memo");
      expect(result.message).toMatch(/^Transaction memo is not a valid Mergepay reference: /);
    }
  });

  it("does not echo attacker-controlled memo text in the failure message", () => {
    const result = validatePaymentMemo(text("MP:<script>x</script>"), CODE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).not.toContain("<script>");
  });
});

describe("validatePaymentMemo — code mismatches", () => {
  it("rejects a well-formed memo for a different settlement", () => {
    expect(validatePaymentMemo(text("MP:ZZZ234XYZ9"), CODE)).toEqual({
      ok: false,
      reason: "code_mismatch",
      message: "Transaction memo does not match the expected settlement reference",
    });
  });

  it("rejects a prefix of the expected code (no partial matching)", () => {
    expect(validatePaymentMemo(text(`MP:${CODE.slice(0, 5)}`), CODE)).toMatchObject({
      ok: false,
      reason: "code_mismatch",
    });
  });

  it("rejects a superstring of the expected code", () => {
    expect(validatePaymentMemo(text(`MP:${CODE}A`), CODE)).toMatchObject({
      ok: false,
      reason: "code_mismatch",
    });
  });

  it("never attributes when the expected code is empty", () => {
    expect(validatePaymentMemo(text("MP:A"), "")).toMatchObject({
      ok: false,
      reason: "code_mismatch",
    });
  });
});

describe("validatePaymentMemo — hash memos", () => {
  it("rejects a well-formed 32-byte hash memo as hash_memo_mismatch", () => {
    const result = validatePaymentMemo(hashOf(Buffer.alloc(MEMO_HASH_BYTES, 7)), CODE);
    expect(result).toMatchObject({ ok: false, reason: "hash_memo_mismatch" });
    if (!result.ok) {
      expect(result.message).toContain('Unexpected memo type: expected "text", got "hash"');
    }
  });

  it("never attributes a hash memo whose bytes spell the MP: reference", () => {
    const padded = Buffer.alloc(MEMO_HASH_BYTES);
    Buffer.from(`MP:${CODE}`).copy(padded);
    expect(validatePaymentMemo(hashOf(padded), CODE)).toMatchObject({
      ok: false,
      reason: "hash_memo_mismatch",
    });
  });

  it.each([
    ["missing payload", undefined],
    ["empty payload", ""],
    ["31 bytes", Buffer.alloc(31, 1).toString("base64")],
    ["33 bytes", Buffer.alloc(33, 1).toString("base64")],
    ["hex instead of base64", "ab".repeat(32)],
    ["not base64", "!!!not-base64!!!"],
    ["url-safe base64 alphabet", Buffer.alloc(32, 0xfb).toString("base64url")],
  ])("rejects a hash memo with %s as invalid_hash_memo", (_label, memo) => {
    const result = validatePaymentMemo({ memoType: "hash", memo }, CODE);
    expect(result).toMatchObject({ ok: false, reason: "invalid_hash_memo" });
    if (!result.ok) {
      expect(result.message).toContain('Unexpected memo type: expected "text", got "hash"');
    }
  });

  it("rejects non-canonical base64 padding bits as invalid_hash_memo", () => {
    const canonical = Buffer.alloc(32, 1).toString("base64"); // ends in "AQE="
    const nonCanonical = `${canonical.slice(0, -2)}F=`;
    expect(Buffer.from(nonCanonical, "base64").length).toBe(32);
    expect(validatePaymentMemo({ memoType: "hash", memo: nonCanonical }, CODE)).toMatchObject({
      ok: false,
      reason: "invalid_hash_memo",
    });
  });
});

describe("validatePaymentMemo — other memo types", () => {
  it.each([
    ["id", "12345"],
    ["return", Buffer.alloc(32).toString("base64")],
    ["TEXT", `MP:${CODE}`],
    ["unknown", `MP:${CODE}`],
  ])("rejects memo_type %s as unsupported_memo_type", (memoType, memo) => {
    expect(validatePaymentMemo({ memoType, memo }, CODE)).toEqual({
      ok: false,
      reason: "unsupported_memo_type",
      message: `Unexpected memo type: expected "text", got "${memoType}"`,
    });
  });

  it("bounds the echoed memo type", () => {
    const result = validatePaymentMemo({ memoType: "x".repeat(500), memo: "1" }, CODE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message.length).toBeLessThan(80);
  });
});
