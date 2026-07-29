import { describe, it, expect } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { stellar, validatePaymentTx, verifySignedPaymentXdr } from "../src/services/stellar";
import { config } from "../src/config";

const from = Keypair.random();
const to = Keypair.random();

const intent = {
  sourcePublicKey: from.publicKey(),
  destination: to.publicKey(),
  asset: { code: "XLM", issuer: null },
  amount: "12.5000000",
  memoCode: "ABC123",
};

function buildXdr(overrides: Partial<typeof intent> = {}): string {
  return stellar.buildPayment({
    sourcePublicKey: overrides.sourcePublicKey ?? intent.sourcePublicKey,
    sourceSequence: "12345",
    destination: overrides.destination ?? intent.destination,
    asset: overrides.asset ?? intent.asset,
    amount: overrides.amount ?? intent.amount,
    memoCode: overrides.memoCode ?? intent.memoCode,
  });
}

describe("payment XDR validation", () => {
  it("accepts a transaction that matches the intent", () => {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    expect(() => validatePaymentTx(tx, intent)).not.toThrow();
  });

  it("rejects a mismatched amount", () => {
    const tx = new Transaction(buildXdr({ amount: "99" }), config.networkPassphrase);
    expect(() => validatePaymentTx(tx, intent)).toThrow(/amount/i);
  });

  it("rejects a mismatched destination", () => {
    const other = Keypair.random().publicKey();
    const tx = new Transaction(
      buildXdr({ destination: other }),
      config.networkPassphrase
    );
    expect(() => validatePaymentTx(tx, intent)).toThrow(/destination/i);
  });

  it("rejects a mismatched memo", () => {
    const tx = new Transaction(
      buildXdr({ memoCode: "DIFFERENT" }),
      config.networkPassphrase
    );
    expect(() => validatePaymentTx(tx, intent)).toThrow(/memo/i);
  });

  it("builds a memo within the 28-byte limit", () => {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    const memo = (tx.memo as any).value.toString();
    expect(memo).toBe("MP:ABC123");
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(28);
  });
});

describe("verifySignedPaymentXdr (pre-submission intent + signature check)", () => {
  function signedXdr(): string {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    tx.sign(from);
    return tx.toXDR();
  }

  it("accepts a validly signed transaction that matches the intent", () => {
    expect(() => verifySignedPaymentXdr(signedXdr(), intent)).not.toThrow();
  });

  it("rejects a malformed XDR without ever reaching Horizon", () => {
    expect(() => verifySignedPaymentXdr("not-a-valid-xdr", intent)).toThrow(/malformed|parse/i);
  });

  it("rejects an unsigned transaction", () => {
    expect(() => verifySignedPaymentXdr(buildXdr(), intent)).toThrow(/sign/i);
  });

  it("rejects a transaction signed for a different network passphrase", () => {
    const otherPassphrase = "Some Other Network ; July 2026";
    const txForOtherNetwork = new Transaction(buildXdr(), otherPassphrase);
    txForOtherNetwork.sign(from);
    const wrongNetworkXdr = txForOtherNetwork.toXDR();
    expect(() => verifySignedPaymentXdr(wrongNetworkXdr, intent)).toThrow(/sign/i);
  });

  it("rejects a transaction whose time bounds have expired", () => {
    const source = new Account(from.publicKey(), "12345");
    const expiredTx = new TransactionBuilder(source, {
      fee: String(Number(BASE_FEE) * 2),
      networkPassphrase: config.networkPassphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) - 100 },
    })
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset: Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text("MP:ABC123"))
      .build();
    expiredTx.sign(from);
    expect(() => verifySignedPaymentXdr(expiredTx.toXDR(), intent)).toThrow(/expired/i);
  });

  it("still rejects an intent mismatch (e.g. amount) once signed", () => {
    const tx = new Transaction(buildXdr({ amount: "99" }), config.networkPassphrase);
    tx.sign(from);
    expect(() => verifySignedPaymentXdr(tx.toXDR(), intent)).toThrow(/amount/i);
  });
});
