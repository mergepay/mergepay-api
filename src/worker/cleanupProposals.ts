import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { auditTx } from "../services/audit";
import { AuditAction } from "../services/audit-actions";
import {
  EXPIRED_TREASURY_PROPOSAL_STATUS,
  OPEN_TREASURY_PROPOSAL_STATUSES,
  effectiveProposalExpiry,
  isProposalExpired,
  proposalExpiryDate,
} from "../services/treasury-proposal-expiry";

export const EXPIRED_STATUS = EXPIRED_TREASURY_PROPOSAL_STATUS;

export interface ExpireStaleProposalsResult {
  expired: number;
  olderThan: Date;
}

export function proposalExpiryCutoff(
  now: Date = new Date(),
  ageDays: number = config.TREASURY_PROPOSAL_EXPIRY_DAYS
): Date {
  return new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
}

export async function expireStaleProposals(params: {
  now?: Date;
  ageDays?: number;
  batchSize?: number;
} = {}): Promise<ExpireStaleProposalsResult> {
  const {
    now = new Date(),
    ageDays = config.TREASURY_PROPOSAL_EXPIRY_DAYS,
    batchSize = config.WORKER_BATCH_SIZE,
  } = params;

  const olderThan = proposalExpiryCutoff(now, ageDays);

  const stale = await prisma.treasuryProposal.findMany({
    where: {
      status: { in: [...OPEN_TREASURY_PROPOSAL_STATUSES] },
      OR: [
        { expiresAt: { lte: now } },
        { expiresAt: null, createdAt: { lt: olderThan } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      groupId: true,
      creatorId: true,
      status: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  let expired = 0;

  for (const proposal of stale) {
    if (!isProposalExpired(proposal, now)) continue;
    const changed = await expireOne(proposal, now);
    if (changed) expired += 1;
  }

  return { expired, olderThan };
}

async function expireOne(
  proposal: {
    id: string;
    groupId: string;
    creatorId: string;
    status: string;
    expiresAt: Date | null;
    createdAt: Date;
  },
  now: Date
): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const { count } = await tx.treasuryProposal.updateMany({
      where: {
        id: proposal.id,
        status: { in: [...OPEN_TREASURY_PROPOSAL_STATUSES] },
      },
      data: {
        status: EXPIRED_STATUS,
        expiresAt: effectiveProposalExpiry(proposal) ?? proposalExpiryDate(undefined, now),
        failureReason: "Proposal expired before reaching its signature threshold",
      },
    });

    if (count === 0) return false;

    await auditTx(tx, {
      userId: proposal.creatorId,
      groupId: proposal.groupId,
      actorType: "worker",
      action: AuditAction.TREASURY_PROPOSAL_EXPIRED,
      entityType: "treasury_proposal",
      entityId: proposal.id,
      correlationId: `job_cleanup_${proposal.id}`,
      metadata: {
        from: proposal.status,
        to: EXPIRED_STATUS,
        ageMs: now.getTime() - proposal.createdAt.getTime(),
        source: "worker",
      },
    });

    return true;
  });
}
