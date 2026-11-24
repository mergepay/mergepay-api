import { describe, expect, it } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";
import { config } from "../../src/config";
import {
  buildTreasuryPaymentXdr,
  validateTreasurySignedXdr,
} from "../../src/services/treasury-stellar";

const source = Keypair.random();
const destination = Keypair.random().publicKey();
const expiresAt = new Date(Date.now() + 120_000);

function intent(overrides: Record<string, unknown> = {}) {
  return {
    sourcePublicKey: source.publicKey(),
    sourceSequence: "2",
    destination,
    asset: { code: "XLM", issuer: null },
    amount: "12.5000000",
    memoCode: "TREASURY1",
    expiresAt,
    resource: "treasury transaction",
    ...overrides,
  };
}

function buildIntentXdr(amount = "12.5000000") {
  return buildTreasuryPaymentXdr({
    sourcePublicKey: source.publicKey(),
    sourceSequence: "1",
    destination,
    asset: { code: "XLM", issuer: null },
    amount,
    memoCode: "TREASURY1",
    validitySeconds: 120,
  });
}

describe("treasury XDR helpers", () => {
  it("builds a valid unsigned payment envelope without private-key handling", () => {
    const xdr = buildIntentXdr();
    const transaction = new Transaction(xdr, config.networkPassphrase);

    expect(transaction.source).toBe(source.publicKey());
    expect(transaction.operations).toHaveLength(1);
    expect(transaction.operations[0].type).toBe("payment");
    expect(transaction.signatures).toHaveLength(0);
  });

  it("accepts a wallet-signed envelope matching the stored intent", () => {
    const transaction = new Transaction(buildIntentXdr(), config.networkPassphrase);
    transaction.sign(source);

    expect(() =>
      validateTreasurySignedXdr(transaction.toXDR(), intent())
    ).not.toThrow();
  });

  it.each([
    ["amount", { amount: "99.0000000" }],
    ["destination", { destination: Keypair.random().publicKey() }],
    ["source", { sourcePublicKey: Keypair.random().publicKey() }],
  ])("rejects a signed envelope with a tampered %s", (_label, expected) => {
    const transaction = new Transaction(buildIntentXdr(), config.networkPassphrase);
    transaction.sign(source);

    expect(() =>
      validateTreasurySignedXdr(transaction.toXDR(), intent(expected))
    ).toThrowError(/match|does not match/i);
  });
});

describe("buildTreasuryPaymentXdr edge cases", () => {
  it("rejects an invalid source public key", () => {
    expect(() =>
      buildTreasuryPaymentXdr({
        sourcePublicKey: "not-a-valid-key",
        sourceSequence: "1",
        destination,
        asset: { code: "XLM", issuer: null },
        amount: "10.0000000",
        memoCode: "TEST",
        validitySeconds: 120,
      })
    ).toThrow();
  });

  it("rejects an invalid destination public key", () => {
    expect(() =>
      buildTreasuryPaymentXdr({
        sourcePublicKey: source.publicKey(),
        sourceSequence: "1",
        destination: "bad-destination-key",
        asset: { code: "XLM", issuer: null },
        amount: "10.0000000",
        memoCode: "TEST",
        validitySeconds: 120,
      })
    ).toThrow();
  });

  it("rejects an unsupported asset code", () => {
    expect(() =>
      buildTreasuryPaymentXdr({
        sourcePublicKey: source.publicKey(),
        sourceSequence: "1",
        destination,
        asset: { code: "FAKECOIN", issuer: Keypair.random().publicKey() },
        amount: "10.0000000",
        memoCode: "TEST",
        validitySeconds: 120,
      })
    ).toThrow();
  });

  it("rejects a non-numeric source sequence", () => {
    expect(() =>
      buildTreasuryPaymentXdr({
        sourcePublicKey: source.publicKey(),
        sourceSequence: "not-a-number",
        destination,
        asset: { code: "XLM", issuer: null },
        amount: "10.0000000",
        memoCode: "TEST",
        validitySeconds: 120,
      })
    ).toThrow();
  });

  it("builds the correct payment operation: destination, asset, and payment type", () => {
    const xdr = buildTreasuryPaymentXdr({
      sourcePublicKey: source.publicKey(),
      sourceSequence: "1",
      destination,
      asset: { code: "XLM", issuer: null },
      amount: "50.0000000",
      memoCode: "PAY1",
      validitySeconds: 120,
    });

    const tx = new Transaction(xdr, config.networkPassphrase);
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0].type).toBe("payment");
    const op = tx.operations[0] as { destination: string; amount: string };
    expect(op.destination).toBe(destination);
    expect(op.amount).toBe("50.0000000");
  });

  it("produces an unsigned envelope with no signatures", () => {
    const xdr = buildTreasuryPaymentXdr({
      sourcePublicKey: source.publicKey(),
      sourceSequence: "1",
      destination,
      asset: { code: "XLM", issuer: null },
      amount: "1.0000000",
      memoCode: "NOSIG",
      validitySeconds: 60,
    });

    const tx = new Transaction(xdr, config.networkPassphrase);
    expect(tx.signatures).toHaveLength(0);
  });
});
