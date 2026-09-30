/**
 * Unit tests for `isValidXdr` (issue #419).
 *
 * The helper is the shared parse-level gate for Stellar transaction XDR, so
 * these tests cover exactly the failure modes an endpoint sees in the wild:
 * valid (signed and unsigned) envelopes, input that is not base64 at all,
 * base64 that does not decode to an XDR, and envelopes that were corrupted
 * or truncated in transit.
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
import { isValidXdr } from "../stellar-xdr";

/** Build a valid, unsigned transaction envelope for the test network. */
function buildXdr(): string {
  return new TransactionBuilder(
    new Account(Keypair.random().publicKey(), "0"),
    { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
  )
    .addOperation(Operation.manageData({ name: "xdr-test", value: "value" }))
    .setTimeout(60)
    .build()
    .toXDR();
}

describe("isValidXdr", () => {
  it("accepts a valid unsigned transaction XDR", () => {
    expect(isValidXdr(buildXdr(), Networks.TESTNET)).toBe(true);
  });

  it("accepts a valid signed transaction XDR", () => {
    const tx = new TransactionBuilder(
      new Account(Keypair.random().publicKey(), "0"),
      { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
    )
      .addOperation(Operation.manageData({ name: "xdr-test", value: "value" }))
      .setTimeout(60)
      .build();
    tx.sign(Keypair.random());
    expect(isValidXdr(tx.toXDR(), Networks.TESTNET)).toBe(true);
  });

  it("accepts a fee-bump envelope wrapping a valid transaction", () => {
    const inner = new TransactionBuilder(
      new Account(Keypair.random().publicKey(), "0"),
      { fee: BASE_FEE, networkPassphrase: Networks.TESTNET }
    )
      .addOperation(Operation.manageData({ name: "xdr-test", value: "value" }))
      .setTimeout(60)
      .build();
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      Keypair.random().publicKey(),
      String(Number(BASE_FEE) * 2),
      inner,
      Networks.TESTNET
    );
    expect(isValidXdr(feeBump.toXDR(), Networks.TESTNET)).toBe(true);
  });

  it("rejects empty or blank input", () => {
    expect(isValidXdr("", Networks.TESTNET)).toBe(false);
    expect(isValidXdr("   ", Networks.TESTNET)).toBe(false);
  });

  it("rejects non-string input at runtime", () => {
    expect(isValidXdr(undefined as unknown as string, Networks.TESTNET)).toBe(false);
    expect(isValidXdr(null as unknown as string, Networks.TESTNET)).toBe(false);
    expect(isValidXdr(12345 as unknown as string, Networks.TESTNET)).toBe(false);
  });

  it.each(["not-xdr!!", "!!!", "AAAA-not-base64", "signed XDR goes here"])(
    "rejects input that is not valid base64: %j",
    (value) => {
      expect(isValidXdr(value, Networks.TESTNET)).toBe(false);
    }
  );

  it("rejects valid base64 that does not decode to an XDR payload", () => {
    expect(isValidXdr(Buffer.from("hello world").toString("base64"), Networks.TESTNET)).toBe(
      false
    );
  });

  it("rejects a corrupted envelope whose payload bytes were altered", () => {
    const bytes = Buffer.from(buildXdr(), "base64");
    // Corrupt the envelope-type word at the head of the payload: the string
    // is still canonical base64, but the decoded XDR no longer names a known
    // envelope type, so parsing fails.
    bytes[0] ^= 0x80;
    expect(isValidXdr(bytes.toString("base64"), Networks.TESTNET)).toBe(false);
  });

  it("rejects a corrupted envelope altered in the middle of the payload", () => {
    const bytes = Buffer.from(buildXdr(), "base64");
    // Scramble a structural word deep inside the envelope (the fixed fields
    // between the source account and the operations), leaving the base64
    // encoding itself perfectly valid.
    bytes[52] ^= 0xff;
    expect(isValidXdr(bytes.toString("base64"), Networks.TESTNET)).toBe(false);
  });

  it("rejects a truncated envelope", () => {
    const xdr = buildXdr();
    expect(isValidXdr(xdr.slice(0, Math.max(1, xdr.length - 20)), Networks.TESTNET)).toBe(
      false
    );
  });

  it("defaults to the configured network passphrase", () => {
    // The default argument must remain a usable passphrase — an undefined one
    // would make every call throw-and-return false, including valid XDRs.
    expect(isValidXdr(buildXdr())).toBe(true);
  });
});
