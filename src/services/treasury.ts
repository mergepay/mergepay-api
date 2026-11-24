/**
 * Unified Treasury Service — Issue #884.
 *
 * Coordinates group treasury operations, multisig proposals, signer configuration,
 * and comprehensive audit logging.
 */

import { prisma } from "../db";
import { Prisma } from "@prisma/client";
import {
  auditTreasurySignerChange,
  auditMultisigActionTx,
  type TreasurySignerChangeAuditParams,
  type MultisigAuditParams,
} from "./audit";
import { treasurySignaturesService } from "./treasury-signatures";
import { verifyTreasuryProposalSignature } from "./treasury-signature-verification";
import {
  verifyMultisigSignatures,
  analyzeMultisigRequirements,
} from "./treasury-multisig-verification";
import type {
  MultisigVerificationParams,
  MultisigVerificationResult,
} from "./treasury-multisig-verification";
import { reconcileTreasuryBalance } from "./treasuryService";
import {
  validateProposedSignerConfig,
  validateSignerChangeAgainstAccount,
  snapshotToSignerConfig,
  type ProposedSignerConfig,
} from "./treasury-validation";

export {
  verifyTreasuryProposalSignature,
  verifyMultisigSignatures,
  analyzeMultisigRequirements,
  treasurySignaturesService,
  reconcileTreasuryBalance,
  auditTreasurySignerChange,
  auditMultisigActionTx,
  validateProposedSignerConfig,
  validateSignerChangeAgainstAccount,
  snapshotToSignerConfig,
};

export type {
  TreasurySignerChangeAuditParams,
  MultisigAuditParams,
  ProposedSignerConfig,
  MultisigVerificationParams,
  MultisigVerificationResult,
};

export interface UpdateTreasurySignersParams {
  groupId: string;
  userId: string;
  actorPublicKey?: string | null;
  treasuryAccountPublicKey: string;
  requiredSigners: number;
  signers?: Array<{ publicKey: string; weight: number }>;
}

/**
 * Updates treasury signer configuration with atomic audit logging.
 */
export async function updateTreasurySigners(
  params: UpdateTreasurySignersParams,
  txClient?: Prisma.TransactionClient
): Promise<void> {
  const runner = async (tx: Prisma.TransactionClient) => {
    const existing = await tx.group.findUnique({
      where: { id: params.groupId },
      select: { treasuryRequiredSigners: true, treasuryAccountPublicKey: true },
    });

    await tx.group.update({
      where: { id: params.groupId },
      data: {
        treasuryEnabled: true,
        treasuryAccountPublicKey: params.treasuryAccountPublicKey,
        treasuryRequiredSigners: params.requiredSigners,
      },
    });

    await auditTreasurySignerChange(
      {
        userId: params.userId,
        actorPublicKey: params.actorPublicKey ?? null,
        groupId: params.groupId,
        treasuryAccountPublicKey: params.treasuryAccountPublicKey,
        requiredSigners: params.requiredSigners,
        previousRequiredSigners: existing?.treasuryRequiredSigners ?? null,
        signers: params.signers,
      },
      tx
    );
  };

  if (txClient) {
    await runner(txClient);
  } else {
    await prisma.$transaction(runner);
  }
}
