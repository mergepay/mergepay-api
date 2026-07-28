import { Keypair, StrKey, Transaction } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../errors";
import { AssetSpec, stellar, toAsset } from "./stellar";

export interface ProposalSignature {
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
    memoCode: `proposal-${Date.now().toString(36)}`,
  });
}

export function validateProposalXdr(xdr: string, treasuryAccount: string): void {
  let tx: Transaction;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("invalid_xdr", "Invalid transaction XDR");
  }

  if (tx.source !== treasuryAccount) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Transaction source does not match the treasury account"
    );
  }

  if (
    tx.operations.length !== 1 ||
    (tx.operations[0] as any).type !== "payment"
  ) {
    throw Errors.badRequest(
      "xdr_mismatch",
      "Treasury proposals must contain exactly one payment operation"
    );
  }
}

export function addSignature(
  xdr: string,
  publicKey: string,
  signature: string
): string {
  if (!StrKey.isValidEd25519PublicKey(publicKey)) {
    throw Errors.badRequest("invalid_public_key", "Invalid Stellar public key");
  }

  let tx: Transaction;
  let decodedSignature: Buffer;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
    decodedSignature = Buffer.from(signature, "base64");
    if (decodedSignature.length !== 64) {
      throw new Error("Invalid Ed25519 signature length");
    }
  } catch {
    throw Errors.badRequest(
      "invalid_signature",
      "Invalid signature or transaction XDR"
    );
  }

  const keypair = Keypair.fromPublicKey(publicKey);
  if (!keypair.verify(tx.hash(), decodedSignature)) {
    throw Errors.badRequest(
      "invalid_signature",
      "Signature does not match the proposal"
    );
  }

  tx.addSignature(publicKey, decodedSignature);
  return tx.toXDR();
}

export async function checkThresholdAndSubmit(params: {
  xdr: string;
  signatures: ProposalSignature[];
  threshold: number;
}): Promise<string> {
  if (params.signatures.length < params.threshold) {
    throw Errors.badRequest(
      "threshold_not_reached",
      "Signature threshold has not been reached"
    );
  }

  let tx: Transaction;
  try {
    tx = new Transaction(params.xdr, config.networkPassphrase);
  } catch {
    throw Errors.badRequest("invalid_xdr", "Invalid transaction XDR");
  }

  const operation = tx.operations[0] as any;
  if (!operation || operation.type !== "payment") {
    throw Errors.badRequest("xdr_mismatch", "Expected a payment operation");
  }

  const memoValue =
    tx.memo && (tx.memo as any).value
      ? (tx.memo as any).value.toString()
      : "";
  if (!memoValue.startsWith("MP:")) {
    throw Errors.badRequest("xdr_mismatch", "Proposal memo is invalid");
  }

  const asset: AssetSpec = operation.asset.isNative()
    ? { code: "XLM", issuer: null }
    : { code: operation.asset.code, issuer: operation.asset.issuer };

  return stellar.submitPayment(params.xdr, {
    sourcePublicKey: tx.source,
    destination: operation.destination,
    asset,
    amount: operation.amount,
    memoCode: memoValue.slice(3),
  });
}

export { toAsset };
