/**
 * Treasury signer validation service.
 * Validates proposed signer configuration changes against Stellar multisig rules.
 */

import { StrKey } from "@stellar/stellar-sdk";
import { Errors } from "../errors";
import type { AccountSnapshot } from "./stellar";

export interface SignerChange {
  publicKey: string;
  weight: number;
}

export interface Thresholds {
  low: number;
  med: number;
  high: number;
}

export interface ProposedSignerConfig {
  signers: SignerChange[];
  thresholds: Thresholds;
}

/**
 * Validate a Stellar public key format.
 */
export function isValidStellarPublicKey(key: string): boolean {
  return StrKey.isValidEd25519PublicKey(key);
}

/**
 * Validate signer weight is within Stellar's allowed range (0-255).
 */
export function isValidSignerWeight(weight: number): boolean {
  return Number.isInteger(weight) && weight >= 0 && weight <= 255;
}

/**
 * Validate threshold is within Stellar's allowed range (0-255).
 */
export function isValidThreshold(threshold: number): boolean {
  return Number.isInteger(threshold) && threshold >= 0 && threshold <= 255;
}

/**
 * Check for duplicate public keys in signer list.
 */
export function hasDuplicateSigners(signers: SignerChange[]): boolean {
  const keys = new Set<string>();
  for (const signer of signers) {
    if (keys.has(signer.publicKey)) {
      return true;
    }
    keys.add(signer.publicKey);
  }
  return false;
}

/**
 * Validate that the proposed configuration can satisfy the high threshold.
 * Returns true if the sum of signer weights meets or exceeds the high threshold.
 */
export function canSatisfyThreshold(config: ProposedSignerConfig): boolean {
  const totalWeight = config.signers.reduce((sum, signer) => sum + signer.weight, 0);
  return totalWeight >= config.thresholds.high;
}

/**
 * Validate a complete proposed signer configuration against Stellar rules.
 */
export function validateProposedSignerConfig(
  config: ProposedSignerConfig,
  currentSnapshot?: AccountSnapshot
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Validate each signer weight
  for (const signer of config.signers) {
    if (!isValidSignerWeight(signer.weight)) {
      errors.push(`Invalid weight for signer ${signer.publicKey}: must be 0-255`);
    }
  }

  // Check for duplicates
  if (hasDuplicateSigners(config.signers)) {
    errors.push("Duplicate public keys in signer list");
  }

  // Validate thresholds
  if (!isValidThreshold(config.thresholds.low)) {
    errors.push("Invalid low threshold: must be 0-255");
  }
  if (!isValidThreshold(config.thresholds.med)) {
    errors.push("Invalid medium threshold: must be 0-255");
  }
  if (!isValidThreshold(config.thresholds.high)) {
    errors.push("Invalid high threshold: must be 0-255");
  }

  // Validate threshold hierarchy (low <= med <= high)
  if (config.thresholds.low > config.thresholds.med) {
    errors.push("Low threshold cannot exceed medium threshold");
  }
  if (config.thresholds.med > config.thresholds.high) {
    errors.push("Medium threshold cannot exceed high threshold");
  }

  // Validate that signers can satisfy the high threshold
  if (!canSatisfyThreshold(config)) {
    errors.push("Signer weights insufficient to satisfy high threshold");
  }

  // If we have current snapshot, validate against it
  if (currentSnapshot && currentSnapshot.exists) {
    const currentKeys = new Set(currentSnapshot.signers.map(s => s.key));
    const proposedKeys = new Set(config.signers.map(s => s.publicKey));

    // Check that all proposed signers exist on-chain (if this is an update)
    for (const key of proposedKeys) {
      if (!currentKeys.has(key)) {
        errors.push(`Proposed signer ${key} does not exist on current account`);
      }
    }
    
    // Skip key validation for signers that already exist on-chain
    // They're already validated by Stellar
    const newSigners = config.signers.filter(s => !currentKeys.has(s.publicKey));
    for (const signer of newSigners) {
      if (!isValidStellarPublicKey(signer.publicKey)) {
        errors.push(`Invalid Stellar public key: ${signer.publicKey}`);
      }
    }
  } else {
    // Validate all keys if no snapshot
    for (const signer of config.signers) {
      if (!isValidStellarPublicKey(signer.publicKey)) {
        errors.push(`Invalid Stellar public key: ${signer.publicKey}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Validate a signer change operation against current account state.
 * This is called before creating unsigned XDR for treasury operations.
 */
export function validateSignerChangeAgainstAccount(
  proposedConfig: ProposedSignerConfig,
  currentSnapshot: AccountSnapshot
): void {
  if (!currentSnapshot.exists) {
    throw Errors.badRequest(
      "account_unfunded",
      "Treasury account does not exist on-chain"
    );
  }

  const validation = validateProposedSignerConfig(proposedConfig, currentSnapshot);
  if (!validation.valid) {
    throw Errors.badRequest(
      "invalid_signer_config",
      validation.errors.join("; ")
    );
  }

  // Ensure the high threshold matches the current account's high threshold
  // (unless this is a threshold change operation, which would need separate validation)
  if (proposedConfig.thresholds.high !== currentSnapshot.thresholds.high) {
    throw Errors.badRequest(
      "threshold_mismatch",
      `Proposed high threshold (${proposedConfig.thresholds.high}) does not match current account threshold (${currentSnapshot.thresholds.high})`
    );
  }
}

/**
 * Extract signer configuration from an account snapshot for validation.
 */
export function snapshotToSignerConfig(snapshot: AccountSnapshot): ProposedSignerConfig {
  return {
    signers: snapshot.signers.map(s => ({
      publicKey: s.key,
      weight: s.weight,
    })),
    thresholds: snapshot.thresholds,
  };
}
