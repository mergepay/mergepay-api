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
import { stellar, validatePaymentTx } from "../src/services/stellar";
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

function buildCustomXdr({
  fee = String(Number(BASE_FEE) * 2),
  operationSource,
  extraOperation = false,
  asset = intent.asset,
}: {
  fee?: string;
  operationSource?: string;
  extraOperation?: boolean;
  asset?: { code: string; issuer?: string | null };
} = {}): string {
  const txb = new TransactionBuilder(new Account(intent.sourcePublicKey, "12345"), {
    fee,
    networkPassphrase: config.networkPassphrase,
  }).addOperation(
    Operation.payment({
      source: operationSource,
      destination: intent.destination,
      asset: asset.issuer ? new Asset(asset.code, asset.issuer) : Asset.native(),
      amount: intent.amount,
    })
  );

  if (extraOperation) {
    txb.addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    );
  }

  return txb.addMemo(Memo.text("MP:ABC123")).setTimeout(300).build().toXDR();
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

  it("rejects a mismatched transaction source", () => {
    const other = Keypair.random().publicKey();
    const tx = new Transaction(
      buildXdr({ sourcePublicKey: other }),
      config.networkPassphrase
    );
    expect(() => validatePaymentTx(tx, intent)).toThrow(/source/i);
  });

  it("rejects a payment operation with an overridden source account", () => {
    const tx = new Transaction(
      buildCustomXdr({ operationSource: Keypair.random().publicKey() }),
      config.networkPassphrase
    );
    expect(() => validatePaymentTx(tx, intent)).toThrow(/operation source/i);
  });

  it("rejects an altered transaction fee", () => {
    const tx = new Transaction(buildCustomXdr({ fee: "999" }), config.networkPassphrase);
    expect(() => validatePaymentTx(tx, intent)).toThrow(/fee/i);
  });

  it("rejects extra operations", () => {
    const tx = new Transaction(
      buildCustomXdr({ extraOperation: true, fee: String(BASE_FEE) }),
      config.networkPassphrase
    );
    expect(() => validatePaymentTx(tx, intent)).toThrow(/one operation/i);
  });

  it("rejects a mismatched memo", () => {
    const tx = new Transaction(
      buildXdr({ memoCode: "DIFFERENT" }),
      config.networkPassphrase
    );
    expect(() => validatePaymentTx(tx, intent)).toThrow(/memo/i);
  });

  it("validates USDC issuer details", () => {
    const usdcIssuer = Keypair.random().publicKey();
    const tx = new Transaction(
      buildCustomXdr({ asset: { code: "USDC", issuer: usdcIssuer } }),
      config.networkPassphrase
    );

    expect(() =>
      validatePaymentTx(tx, {
        ...intent,
        asset: { code: "USDC", issuer: usdcIssuer },
      })
    ).not.toThrow();
    expect(() =>
      validatePaymentTx(tx, {
        ...intent,
        asset: { code: "USDC", issuer: Keypair.random().publicKey() },
      })
    ).toThrow(/asset/i);
  });

  it("returns a controlled validation error for malformed XDR", async () => {
    await expect(stellar.submitPayment("not-xdr", intent)).rejects.toMatchObject({
      code: "XDR_MISMATCH",
      statusCode: 400,
    });
  });

  it("builds a memo within the 28-byte limit", () => {
    const tx = new Transaction(buildXdr(), config.networkPassphrase);
    const memo = (tx.memo as any).value.toString();
    expect(memo).toBe("MP:ABC123");
    expect(Buffer.byteLength(memo)).toBeLessThanOrEqual(28);
  });
});
