import { Keypair, StrKey, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { stellar, AssetSpec } from "./stellar";

export interface TreasurySignature {
  publicKey: string;
  signature: string;
}

export async function buildPaymentXdr(
  treasuryAccount: string,
  destination: string,
  amount: string,
  asset: AssetSpec
): Promise<string> {
  const account = await stellar.loadAccount(treasuryAccount);
  if (!account.exists) {
    throw Errors.badRequest(
      "treasury_unfunded",
      "Treasury account is not funded"
    );
  }

  return stellar.buildPayment({
    sourcePublicKey: treasuryAccount,
    sourceSequence: account.sequence,
    destination,
    asset,
    amount,
    memoCode: `T${Date.now().toString(36)}`,
  });
}

/**
 * Validate and attach a signature to a transaction envelope.
 * The signature is expected to be standard Base64, while the public key is a
 * Stellar StrKey-encoded public key.
 */
export function addSignature(
  xdr: string,
  publicKey: string,
  signature: string
): string {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw Errors.badRequest(
      "invalid_public_key",
      "Invalid signer public key"
    );
  }

  try {
    const tx = new Transaction(xdr, config.networkPassphrase);
    const signatureBytes = Buffer.from(signature, "base64");

    if (
      signatureBytes.length !== 64 ||
      !Keypair.fromPublicKey(publicKey).verify(tx.hash(), signatureBytes)
    ) {
      throw Errors.badRequest(
        "invalid_signature",
        "Signature is not valid for this transaction"
      );
    }

    tx.addSignature(publicKey, signature);
    return tx.toXDR();
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) {
      throw error;
    }
    throw Errors.badRequest(
      "invalid_signature",
      "The signed transaction is invalid"
    );
  }
}

export async function checkThresholdAndSubmit(proposal: {
  xdr: string;
  signatures: TreasurySignature[];
  threshold: number;
}): Promise<string | null> {
  if (proposal.signatures.length < proposal.threshold) {
    return null;
  }

  let signedXdr = proposal.xdr;
  for (const signature of proposal.signatures) {
    signedXdr = addSignature(
      signedXdr,
      signature.publicKey,
      signature.signature
    );
  }

  return stellar.submitSignedTransaction(signedXdr);
}

/** Extract a signer's signature from a wallet-returned signed XDR. */
export function extractSignature(
  signedXdr: string,
  publicKey: string,
  originalXdr: string
): string {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw Errors.badRequest(
      "invalid_public_key",
      "Invalid signer public key"
    );
  }

  try {
    const signed = new Transaction(signedXdr, config.networkPassphrase);
    const original = new Transaction(originalXdr, config.networkPassphrase);
    const rawPublicKey = StrKey.decodeEd25519PublicKey(publicKey);
    const hint = Buffer.from(rawPublicKey).subarray(-4);

    if (signed.hash().toString("hex") !== original.hash().toString("hex")) {
      throw Errors.badRequest(
        "invalid_signature",
        "Signed XDR does not match this proposal"
      );
    }

    const found = signed.signatures.find((decorated) =>
      Buffer.from(decorated.hint()).equals(hint)
    );

    if (!found) {
      throw Errors.badRequest(
        "invalid_signature",
        "Signed XDR does not contain a signature for this public key"
      );
    }

    const signature = Buffer.from(found.signature()).toString("base64");
    addSignature(originalXdr, publicKey, signature);
    return signature;
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) {
      throw error;
    }
    throw Errors.badRequest(
      "invalid_signature",
      "The signed transaction is invalid"
    );
  }
}
