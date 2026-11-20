/**
 * Treasury proposal signature verification helper (issue #1087).
 *
 * Checks that an Ed25519 signature really is the named signer's signature over
 * the proposal transaction's hash. Only public keys and signatures are ever
 * handled here — never secret keys.
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { config } from "../config";
import { Errors } from "../lib/errors";

export interface VerifyTreasurySignatureParams {
  /** The proposal's transaction envelope XDR (base64). */
  xdr: string;
  /** Stellar public key (G...) of the signer claiming the signature. */
  signerPublicKey: string;
  /** Raw Ed25519 signature, as a Buffer or base64 string. */
  signature: Buffer | string;
  /** When given, `signerPublicKey` must be one of these active signers. */
  authorizedSigners?: Iterable<string>;
  networkPassphrase?: string;
}

/**
 * Throws 400 for a malformed XDR/key/signature or a signature that does not
 * verify, and 403 for a valid key that is not an active signer. Returns the
 * transaction hash (hex) the signature was verified against.
 */
export function verifyTreasuryProposalSignature(
  params: VerifyTreasurySignatureParams
): string {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(params.signerPublicKey);
  } catch {
    throw Errors.badRequest("invalid_signer_key", "Signer public key is not a valid Stellar public key");
  }

  if (params.authorizedSigners) {
    const allowed = new Set(params.authorizedSigners);
    if (!allowed.has(params.signerPublicKey)) {
      throw Errors.forbidden("Public key is not an active signer for this treasury");
    }
  }

  let hash: Buffer;
  try {
    const tx = TransactionBuilder.fromXDR(
      params.xdr,
      params.networkPassphrase ?? config.networkPassphrase
    );
    hash = tx.hash();
  } catch {
    throw Errors.badRequest("invalid_xdr", "Transaction XDR could not be parsed");
  }

  let sig: Buffer;
  if (typeof params.signature === "string") {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(params.signature)) {
      throw Errors.badRequest("invalid_signature", "Signature is not valid base64");
    }
    sig = Buffer.from(params.signature, "base64");
  } else {
    sig = params.signature;
  }
  if (sig.length !== 64) {
    throw Errors.badRequest("invalid_signature", "Signature must be a 64-byte Ed25519 signature");
  }

  let verified = false;
  try {
    verified = keypair.verify(hash, sig);
  } catch {
    verified = false;
  }
  if (!verified) {
    throw Errors.badRequest(
      "invalid_signature",
      `Signature for ${params.signerPublicKey} did not verify against the proposed transaction`
    );
  }
  return hash.toString("hex");
}
