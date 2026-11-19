import { describe, it, expect } from "vitest";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "../src/config";
import { verifyTreasuryProposalSignature } from "../src/services/treasury";
import { AppError } from "../src/errors";

const treasury = Keypair.random();
const signer = Keypair.random();
const outsider = Keypair.random();

function buildTx() {
  return new TransactionBuilder(new Account(treasury.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      })
    )
    .setTimeout(300)
    .build();
}

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.statusCode : undefined;
  }
  return undefined;
}

describe("verifyTreasuryProposalSignature (#1087)", () => {
  const tx = buildTx();
  const xdr = tx.toXDR();
  const good = signer.sign(tx.hash());

  it("accepts a valid signature (Buffer or base64) and returns the tx hash", () => {
    const params = { xdr, signerPublicKey: signer.publicKey() };
    expect(verifyTreasuryProposalSignature({ ...params, signature: good })).toBe(tx.hash().toString("hex"));
    expect(
      verifyTreasuryProposalSignature({ ...params, signature: good.toString("base64") })
    ).toBe(tx.hash().toString("hex"));
  });

  it("rejects a signature made by a different key with 400", () => {
    const forged = outsider.sign(tx.hash());
    expect(
      statusOf(() =>
        verifyTreasuryProposalSignature({ xdr, signerPublicKey: signer.publicKey(), signature: forged })
      )
    ).toBe(400);
  });

  it("rejects a signature over a different transaction with 400", () => {
    const other = signer.sign(buildTx().hash());
    expect(
      statusOf(() =>
        verifyTreasuryProposalSignature({ xdr, signerPublicKey: signer.publicKey(), signature: other })
      )
    ).toBe(400);
  });

  it("rejects malformed signature, key and XDR with 400", () => {
    const base = { xdr, signerPublicKey: signer.publicKey(), signature: good };
    expect(statusOf(() => verifyTreasuryProposalSignature({ ...base, signature: "not base64!" }))).toBe(400);
    expect(statusOf(() => verifyTreasuryProposalSignature({ ...base, signature: Buffer.alloc(10) }))).toBe(400);
    expect(statusOf(() => verifyTreasuryProposalSignature({ ...base, signerPublicKey: "GBAD" }))).toBe(400);
    expect(statusOf(() => verifyTreasuryProposalSignature({ ...base, xdr: "garbage" }))).toBe(400);
  });

  it("rejects a valid signature from a non-signer with 403", () => {
    const sig = outsider.sign(tx.hash());
    expect(
      statusOf(() =>
        verifyTreasuryProposalSignature({
          xdr,
          signerPublicKey: outsider.publicKey(),
          signature: sig,
          authorizedSigners: [signer.publicKey()],
        })
      )
    ).toBe(403);
  });

  it("accepts an authorized signer", () => {
    expect(() =>
      verifyTreasuryProposalSignature({
        xdr,
        signerPublicKey: signer.publicKey(),
        signature: good,
        authorizedSigners: new Set([signer.publicKey()]),
      })
    ).not.toThrow();
  });
});
