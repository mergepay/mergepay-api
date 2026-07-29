import { describe, it, expect } from "vitest";
import { Keypair, Transaction, TransactionBuilder, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
import {
  stellar,
  parseSignedPaymentXdr,
  assertTimeBoundsValid,
  validateSignedPaymentXdr,
} from "../src/services/stellar";
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

describe("parseSignedPaymentXdr", () => {
  it("parses a well-formed transaction envelope", () => {
    const tx = parseSignedPaymentXdr(buildXdr());
    expect(tx).toBeInstanceOf(Transaction);
  });

  it("rejects malformed base64/XDR without throwing an uncaught exception", () => {
    expect(() => parseSignedPaymentXdr("not-a-valid-xdr-envelope")).toThrow(/could not be parsed/i);
  });

  it("rejects fee-bump transaction envelopes", () => {
    const inner = new Transaction(buildXdr(), config.networkPassphrase);
    const feeBumpXdr = TransactionBuilder.buildFeeBumpTransaction(
      from,
      String(Number(BASE_FEE) * 10),
      inner,
      config.networkPassphrase
    ).toXDR();
    expect(() => parseSignedPaymentXdr(feeBumpXdr)).toThrow(/fee-bump/i);
  });
});

describe("assertTimeBoundsValid", () => {
  it("accepts a transaction with no explicit expiry issue", () => {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    expect(() => assertTimeBoundsValid(tx)).not.toThrow();
  });

  it("rejects a transaction whose time bounds have already expired", () => {
    const account = new (require("@stellar/stellar-sdk").Account)(from.publicKey(), "12345");
    const builder = new TransactionBuilder(account, {
      fee: String(Number(BASE_FEE) * 2),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: to.publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimebounds(1, Math.floor(Date.now() / 1000) - 60)
      .build();
    expect(() => assertTimeBoundsValid(builder)).toThrow(/expired/i);
  });
});

describe("validateSignedPaymentXdr", () => {
  it("returns the parsed transaction when it matches the intent", () => {
    const tx = validateSignedPaymentXdr(buildXdr(), intent);
    expect(tx).toBeInstanceOf(Transaction);
  });

  it("rejects a destination swapped between XDR creation and signing", () => {
    const other = Keypair.random().publicKey();
    expect(() =>
      validateSignedPaymentXdr(buildXdr({ destination: other }), intent)
    ).toThrow(/destination/i);
  });

  it("rejects an amount changed after the fact", () => {
    expect(() =>
      validateSignedPaymentXdr(buildXdr({ amount: "999" }), intent)
    ).toThrow(/amount/i);
  });

  it("rejects a memo that no longer references the expected settlement", () => {
    expect(() =>
      validateSignedPaymentXdr(buildXdr({ memoCode: "OTHER99" }), intent)
    ).toThrow(/memo/i);
  });

  it("rejects an asset issuer swap", () => {
    expect(() =>
      validateSignedPaymentXdr(
        buildXdr({
          asset: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
        }),
        intent
      )
    ).toThrow(/asset/i);
  });

  it("rejects garbage input without throwing an uncaught exception", () => {
    expect(() => validateSignedPaymentXdr("////not-xdr////", intent)).toThrow(
      /could not be parsed/i
    );
  });
});
