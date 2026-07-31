import { describe, it, expect } from "vitest";
import { Keypair, Transaction, TransactionBuilder, Account, Operation, Asset, BASE_FEE, Memo } from "@stellar/stellar-sdk";
import { stellar, verifyMultisig, memoText } from "../src/services/stellar";
import { config } from "../src/config";

const signer1 = Keypair.random();
const signer2 = Keypair.random();
const signer3 = Keypair.random();
const outsider = Keypair.random();
const destination = Keypair.random().publicKey();

const intent = {
  sourcePublicKey: signer1.publicKey(),
  destination,
  asset: { code: "XLM", issuer: null },
  amount: "50.0000000",
  memoCode: "TREASURY1",
};

function buildEnvelope(): Transaction {
  const xdr = stellar.buildPayment({
    sourcePublicKey: intent.sourcePublicKey,
    sourceSequence: "100",
    destination: intent.destination,
    asset: intent.asset,
    amount: intent.amount,
    memoCode: intent.memoCode,
  });
  return new Transaction(xdr, config.networkPassphrase);
}

function sign(tx: Transaction, ...keys: Keypair[]): Transaction {
  const clone = new Transaction(tx.toXDR(), config.networkPassphrase);
  clone.sign(...keys);
  return clone;
}

describe("verifyMultisig", () => {
  it("accepts when the threshold of configured signers is met", () => {
    const tx = sign(buildEnvelope(), signer1, signer2);
    expect(() =>
      verifyMultisig(tx, {
        signers: [signer1.publicKey(), signer2.publicKey(), signer3.publicKey()],
        threshold: 2,
      })
    ).not.toThrow();
  });

  it("rejects when fewer than the threshold have signed", () => {
    const tx = sign(buildEnvelope(), signer1);
    expect(() =>
      verifyMultisig(tx, {
        signers: [signer1.publicKey(), signer2.publicKey(), signer3.publicKey()],
        threshold: 2,
      })
    ).toThrow();
  });

  it("rejects a signature from an account outside the configured signer set", () => {
    const tx = sign(buildEnvelope(), signer1, outsider);
    expect(() =>
      verifyMultisig(tx, {
        signers: [signer1.publicKey(), signer2.publicKey()],
        threshold: 1,
      })
    ).toThrow();
  });

  it("does not double-count a duplicate signature from the same signer", () => {
    // signTransaction with the same key twice yields two byte-identical
    // decorated signatures on an ed25519 envelope (deterministic signing).
    const tx = sign(buildEnvelope(), signer1, signer1);
    expect(() =>
      verifyMultisig(tx, {
        signers: [signer1.publicKey(), signer2.publicKey()],
        threshold: 2,
      })
    ).toThrow();
  });

  it("rejects an envelope with no signatures", () => {
    const tx = buildEnvelope();
    expect(() =>
      verifyMultisig(tx, { signers: [signer1.publicKey()], threshold: 1 })
    ).toThrow();
  });

  it("rejects when no signers are configured", () => {
    const tx = sign(buildEnvelope(), signer1);
    expect(() => verifyMultisig(tx, { signers: [], threshold: 1 })).toThrow();
  });
});

describe("stellar.submitMultisigPayment", () => {
  it("rejects a malformed envelope without attempting submission", async () => {
    await expect(
      stellar.submitMultisigPayment("not-valid-xdr", intent, {
        signers: [signer1.publicKey()],
        threshold: 1,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an altered operation (amount tampering) before checking signatures", async () => {
    const source = new Account(signer1.publicKey(), "100");
    const tampered = new TransactionBuilder(source, {
      fee: String(Number(BASE_FEE) * 2),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination,
          asset: Asset.native(),
          amount: "999999.0000000",
        })
      )
      .addMemo(Memo.text(memoText(intent.memoCode)))
      .setTimeout(300)
      .build();
    tampered.sign(signer1, signer2);

    await expect(
      stellar.submitMultisigPayment(tampered.toXDR(), intent, {
        signers: [signer1.publicKey(), signer2.publicKey()],
        threshold: 2,
      })
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects an envelope signed by only one of two required signers", async () => {
    const tx = sign(buildEnvelope(), signer1);
    await expect(
      stellar.submitMultisigPayment(tx.toXDR(), intent, {
        signers: [signer1.publicKey(), signer2.publicKey()],
        threshold: 2,
      })
    ).rejects.toMatchObject({ status: 401 });
  });
});
