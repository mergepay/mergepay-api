/**
 * Treasury multisig transaction verification helper — Issue #837.
 *
 * Provides utilities to inspect unsigned and partially signed XDRs against
 * the expected threshold and signer configuration stored in the treasury settings.
 *
 * This helper extracts signature verification logic from the broader
 * treasury-signatures service so it can be reused for validation-only
 * operations without mutating database state.
 *
 * Security properties:
 *   - Never stores or handles user private keys; only inspects public signatures
 *   - Validates that required signers match the treasury multisig configuration
 *   - Returns structured validation results for threshold status
 */

import { Keypair, Transaction } from "@stellar/stellar-sdk";
import { stellar } from "./stellar";
import { config } from "../config";
import { Errors } from "../errors";

export interface MultisigVerificationResult {
  /** Whether the transaction has enough signatures to meet the threshold */
  meetsThreshold: boolean;
  /** Current total weight of verified signatures */
  totalWeight: number;
  /** Required threshold weight for the treasury account */
  requiredWeight: number;
  /** Number of verified signatures */
  signatureCount: number;
  /** Details about each verified signature */
  signatures: Array<{
    publicKey: string;
    weight: number;
    verified: boolean;
  }>;
  /** Source account of the transaction */
  sourceAccount: string;
}

export interface MultisigVerificationParams {
  /** Base64-encoded XDR transaction envelope (may be signed or unsigned) */
  xdr: string;
  /** Treasury account public key */
  treasuryAccountPublicKey: string;
  /** Set of authorized signer public keys for this treasury */
  authorizedSigners: Set<string>;
  /**
   * Live signer weights already read from Horizon, keyed by public key.
   *
   * Callers that have just loaded the treasury account (for example the
   * signature submission path, which needs the same weights for its own
   * threshold decision) pass them here so verification does not need a second
   * Horizon round trip. Omit them to have the account loaded and inspected.
   */
  signerWeights?: ReadonlyMap<string, number>;
  /** High threshold already read from Horizon; pairs with `signerWeights`. */
  requiredWeight?: number;
}

/**
 * Verify signatures on a Stellar transaction XDR against a treasury's multisig configuration.
 *
 * @param params - XDR string, treasury account public key, and authorized signers set
 * @returns Structured verification result with threshold status and signature details
 * @throws {AppError} If the XDR cannot be parsed or the account is unfunded
 */
export async function verifyMultisigSignatures(
  params: MultisigVerificationParams
): Promise<MultisigVerificationResult> {
  const { xdr, treasuryAccountPublicKey, authorizedSigners } = params;

  // Parse the transaction envelope
  let tx: Transaction;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch (err) {
    throw Errors.badRequest(
      "xdr_parse_failed",
      "Could not parse transaction XDR"
    );
  }

  // Verify the source account matches the treasury
  if (tx.source !== treasuryAccountPublicKey) {
    throw Errors.badRequest(
      "source_account_mismatch",
      "Transaction source account does not match treasury account"
    );
  }

  // Threshold and signer weights come from Horizon unless the caller already
  // holds a fresh snapshot of them.
  const snapshot =
    params.signerWeights !== undefined && params.requiredWeight !== undefined
      ? { weights: params.signerWeights, threshold: params.requiredWeight }
      : await (async () => {
          const account = await stellar.loadAccount(treasuryAccountPublicKey);
          if (!account.exists) {
            throw Errors.badRequest(
              "treasury_unfunded",
              "Treasury account is not funded on-chain"
            );
          }
          return {
            weights: new Map(account.signers.map((s) => [s.key, s.weight])),
            threshold: account.thresholds.high,
          };
        })();

  const requiredWeight = snapshot.threshold;
  const onChainWeight = snapshot.weights;

  // Verify each signature against authorized signers
  const signatures: MultisigVerificationResult["signatures"] = [];
  const txHash = tx.hash();

  for (const decorated of tx.signatures as any[]) {
    const hint: Buffer = decorated.hint();
    const signature: Buffer = decorated.signature();

    // Find the matching public key from the signature hint
    let matchedPublicKey: string | null = null;
    let weight = 0;

    for (const publicKey of authorizedSigners) {
      try {
        if (Keypair.fromPublicKey(publicKey).signatureHint().equals(hint)) {
          matchedPublicKey = publicKey;
          weight = onChainWeight.get(publicKey) ?? 0;
          break;
        }
      } catch {
        // Invalid public key format - skip
        continue;
      }
    }

    if (!matchedPublicKey) {
      // Signature from unauthorized signer - include as unverified
      signatures.push({
        publicKey: "unknown",
        weight: 0,
        verified: false,
      });
      continue;
    }

    // Cryptographically verify the signature
    let verified = false;
    try {
      verified = Keypair.fromPublicKey(matchedPublicKey).verify(
        txHash,
        signature
      );
    } catch {
      verified = false;
    }

    signatures.push({
      publicKey: matchedPublicKey,
      weight,
      verified,
    });
  }

  // Calculate total weight from verified signatures (deduplicated by public key)
  const verifiedSignatures = new Map<string, number>();
  for (const sig of signatures) {
    if (sig.verified && sig.publicKey !== "unknown") {
      // Use the highest weight if multiple signatures from the same key
      const existing = verifiedSignatures.get(sig.publicKey) ?? 0;
      if (sig.weight > existing) {
        verifiedSignatures.set(sig.publicKey, sig.weight);
      }
    }
  }

  const totalWeight = Array.from(verifiedSignatures.values()).reduce(
    (sum, w) => sum + w,
    0
  );

  const signatureCount = signatures.filter((s) => s.verified).length;

  return {
    meetsThreshold: totalWeight >= requiredWeight,
    totalWeight,
    requiredWeight,
    signatureCount,
    signatures,
    sourceAccount: tx.source,
  };
}

/**
 * Analyze an unsigned XDR to determine signature requirements without verifying signatures.
 *
 * This is useful for previewing what signatures would be needed before collecting them.
 *
 * @param xdr - Base64-encoded unsigned XDR transaction envelope
 * @param treasuryAccountPublicKey - Treasury account public key
 * @returns Threshold and signer configuration information
 * @throws {AppError} If the XDR cannot be parsed or the account is unfunded
 */
export async function analyzeMultisigRequirements(
  xdr: string,
  treasuryAccountPublicKey: string
): Promise<{
  requiredWeight: number;
  sourceAccount: string;
  availableSigners: Array<{ publicKey: string; weight: number }>;
}> {
  let tx: Transaction;
  try {
    tx = new Transaction(xdr, config.networkPassphrase);
  } catch (err) {
    throw Errors.badRequest(
      "xdr_parse_failed",
      "Could not parse transaction XDR"
    );
  }

  if (tx.source !== treasuryAccountPublicKey) {
    throw Errors.badRequest(
      "source_account_mismatch",
      "Transaction source account does not match treasury account"
    );
  }

  const account = await stellar.loadAccount(treasuryAccountPublicKey);
  if (!account.exists) {
    throw Errors.badRequest(
      "treasury_unfunded",
      "Treasury account is not funded on-chain"
    );
  }

  return {
    requiredWeight: account.thresholds.high,
    sourceAccount: tx.source,
    availableSigners: account.signers.map((s) => ({
      publicKey: s.key,
      weight: s.weight,
    })),
  };
}
