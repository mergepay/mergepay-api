import { prisma } from "../db";
import { Errors } from "../errors";
import type { AccountSnapshot } from "./stellar";

interface TreasuryPolicyParams {
  groupId: string;
  treasuryAccountPublicKey: string;
  requiredSigners: number;
  snapshot: AccountSnapshot;
}

/**
 * Verify that the current on-chain treasury signer configuration matches the
 * local group policy before any treasury transaction XDR is created.
 *
 * Group members are the persisted signer policy. The treasury account's own
 * master signer may remain on-chain with weight zero, but any other active
 * signer must belong to the group and every group member must have a positive
 * on-chain signer weight.
 */
export async function assertTreasuryPolicy({
  groupId,
  treasuryAccountPublicKey,
  requiredSigners,
  snapshot,
}: TreasuryPolicyParams): Promise<void> {
  if (!snapshot.exists) {
    throw Errors.badRequest(
      "treasury_unfunded",
      "The treasury account is not funded"
    );
  }

  if (!Number.isInteger(requiredSigners) || requiredSigners < 1) {
    throw Errors.badRequest(
      "invalid_treasury_policy",
      "The treasury signer threshold is invalid"
    );
  }

  if (snapshot.thresholds.high !== requiredSigners) {
    throw Errors.badRequest(
      "stale_treasury_policy",
      "The treasury account threshold does not match the configured policy"
    );
  }

  const members = await prisma.groupMember.findMany({
    where: { groupId },
    select: {
      user: {
        select: { stellarPublicKey: true },
      },
    },
  });

  const expectedSignerKeys = new Set(
    members
      .map((member) => member.user.stellarPublicKey)
      .filter((key): key is string => Boolean(key))
  );

  if (expectedSignerKeys.size === 0) {
    throw Errors.badRequest(
      "invalid_treasury_policy",
      "The treasury has no configured group signers"
    );
  }

  const onChainSigners = new Map(
    snapshot.signers.map((signer) => [signer.key, signer.weight])
  );

  for (const signer of snapshot.signers) {
    // The account master signer is normally present in Horizon responses. It
    // must be disabled for a multisig treasury and is not a group signer.
    if (signer.key === treasuryAccountPublicKey) {
      if (signer.weight !== 0) {
        throw Errors.badRequest(
          "stale_treasury_policy",
          "The treasury master signer must have zero weight"
        );
      }
      continue;
    }

    if (!expectedSignerKeys.has(signer.key) && signer.weight > 0) {
      throw Errors.badRequest(
        "stale_treasury_policy",
        "The treasury account contains an unknown or inactive signer"
      );
    }
  }

  let totalWeight = 0;
  for (const signerKey of expectedSignerKeys) {
    const weight = onChainSigners.get(signerKey);
    if (weight === undefined || weight <= 0) {
      throw Errors.badRequest(
        "stale_treasury_policy",
        "A configured treasury signer is missing or has insufficient weight"
      );
    }
    totalWeight += weight;
  }

  if (totalWeight < snapshot.thresholds.high) {
    throw Errors.badRequest(
      "insufficient_treasury_weight",
      "The configured treasury signers cannot satisfy the account threshold"
    );
  }
}
