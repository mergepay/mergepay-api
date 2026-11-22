/**
 * Background worker task for processing pending treasury multisig submissions (#895).
 *
 * Polls for treasury proposals that have reached their required signature threshold,
 * verifies multisig weights, attempts broadcast to the Stellar network with retry logic,
 * and transitions proposal states to SUBMITTED or FAILED with audit tracking.
 */
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { auditTx } from "../services/audit";
import { AuditAction } from "../services/audit-actions";
import { stellar } from "../services/stellar";
import { type RetryPolicy } from "../services/job-retry";
import { isProposalExpired } from "../services/treasury-proposal-expiry";
import { executeWorkerJobWithRetry } from "./job-retry-handler";

export interface ProcessPendingMultisigResult {
  processed: number;
  submitted: number;
  failed: number;
}

export const MULTISIG_STATUS = {
  pending: "pending",
  awaitingSignatures: "awaiting_signatures",
  ready: "ready",
  submitted: "submitted",
  confirmed: "confirmed",
  failed: "failed",
} as const;

/**
 * Poll and execute pending treasury multisig proposals that have met threshold.
 */
export async function processPendingTreasuryMultisig(params: {
  batchSize?: number;
  policy?: RetryPolicy;
  sleep?: (ms: number) => Promise<void>;
} = {}): Promise<ProcessPendingMultisigResult> {
  const { batchSize = config.WORKER_BATCH_SIZE ?? 50, policy, sleep } = params;
  const now = new Date();

  // Retrieve candidate proposals that are ready or awaiting submission
  const proposals = await prisma.treasuryProposal.findMany({
    where: {
      status: { in: [MULTISIG_STATUS.ready, MULTISIG_STATUS.pending, MULTISIG_STATUS.awaitingSignatures] },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    take: batchSize,
    orderBy: { createdAt: "asc" },
  });

  let processed = 0;
  let submitted = 0;
  let failed = 0;

  for (const proposal of proposals) {
    if (isProposalExpired(proposal, now)) continue;

    const rawSignatures = (proposal.signatures as unknown as Array<{ publicKey: string; signature: string }>) || [];
    const signatureCount = rawSignatures.length;

    // Only process proposals that meet or exceed required threshold
    if (signatureCount < proposal.threshold) {
      continue;
    }

    processed += 1;

    const execution = await executeWorkerJobWithRetry(
      async () => {
        let stellarTxHash = proposal.txHash;
        if (proposal.xdr) {
          stellarTxHash = await stellar.submitSigned(proposal.xdr);
        }

        // Mark submitted atomically
        await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
          await tx.treasuryProposal.update({
            where: { id: proposal.id },
            data: {
              status: MULTISIG_STATUS.submitted,
              txHash: stellarTxHash,
            },
          });
        });

        return stellarTxHash;
      },
      {
        taskName: "treasury_multisig_broadcast",
        jobId: proposal.id,
        policy,
        sleep,
        onDeadLetter: async ({ reason }) => {
          await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            await tx.treasuryProposal.update({
              where: { id: proposal.id },
              data: {
                status: MULTISIG_STATUS.failed,
              },
            });

            await auditTx(tx, {
              userId: proposal.creatorId,
              actorType: "worker",
              action: AuditAction.TREASURY_PROPOSAL_FAILED,
              entityType: "treasury_proposal",
              entityId: proposal.id,
              outcome: "failure",
              metadata: {
                reason,
                source: "worker",
              },
            });
          });
        },
      }
    );

    if (execution.success) {
      submitted += 1;
    } else {
      failed += 1;
    }
  }

  return { processed, submitted, failed };
}
