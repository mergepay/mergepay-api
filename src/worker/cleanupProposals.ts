/**
 * Expiry for stale treasury multisig proposals.
 *
 * A proposal is created unsigned and waits for group signers to reach its
 * threshold. Nothing currently ends that wait: a proposal nobody finishes
 * signing stays `pending` forever, cluttering every treasury view and leaving
 * an envelope that is no longer submittable presented as though it still is.
 *
 * The envelope really does go stale. It carries time bounds and is built
 * against a treasury account sequence number, so once the account advances or
 * the bounds lapse, Horizon rejects it — the proposal's signatures cannot
 * produce a valid submission no matter how many arrive later. Marking it
 * `expired` records the state the chain already put it in.
 *
 * ## Why a sweep rather than a check on read
 *
 * Deciding expiry when a proposal is read would leave the stored status
 * disagreeing with what the API returns, and would never fire for proposals
 * nobody looks at. A sweep makes the transition durable and auditable: the row
 * moves once, an audit record explains why, and every later reader sees the
 * same thing.
 *
 * ## Safety
 *
 * The update is conditional on the row still being `pending`, so a proposal
 * that is signed or submitted in the same instant is never clobbered — the
 * conditional matches zero rows and the winner's state stands. Each proposal
 * is transitioned with its audit record in one transaction, so a reader can
 * never observe an expired proposal with no explanation of how it got there.
 */
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { auditTx } from "../services/audit";

/** Status a proposal must still hold to be eligible for expiry. */
const PENDING_STATUS = "pending";

/** Status a swept proposal is moved to. */
export const EXPIRED_STATUS = "expired";

export interface ExpireStaleProposalsResult {
  /** Proposals whose status this run actually changed. */
  expired: number;
  /** The cutoff used, exposed so a caller or test can assert on it. */
  olderThan: Date;
}

/**
 * The age at which a pending proposal is considered abandoned.
 *
 * Configuration-driven so an operator can tune it without a deploy of new
 * logic, and so tests can drive it directly rather than manipulating clocks.
 */
export function proposalExpiryCutoff(
  now: Date = new Date(),
  ageDays: number = config.TREASURY_PROPOSAL_EXPIRY_DAYS
): Date {
  return new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1000);
}

/**
 * Move pending proposals older than the configured threshold to `expired`.
 *
 * Batched: a backlog is worked through over successive worker cycles rather
 * than in one unbounded update, so a first run against a long-lived deployment
 * cannot hold a large write transaction open.
 */
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
    where: { status: PENDING_STATUS, createdAt: { lt: olderThan } },
    // Oldest first: if a backlog spans more than one batch, the most overdue
    // proposals are the ones that clear first.
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: { id: true, groupId: true, creatorId: true, createdAt: true },
  });

  let expired = 0;

  for (const proposal of stale) {
    const changed = await expireOne(proposal, now);
    if (changed) expired += 1;
  }

  return { expired, olderThan };
}

/**
 * Expire a single proposal atomically with its audit record.
 *
 * Returns false when the row was no longer `pending` — a signer reached the
 * threshold between the query above and this write, and their outcome wins.
 */
async function expireOne(
  proposal: { id: string; groupId: string; creatorId: string; createdAt: Date },
  now: Date
): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Conditional on the status, not just the id: this is what makes the sweep
    // safe to run alongside live signing traffic.
    const { count } = await tx.treasuryProposal.updateMany({
      where: { id: proposal.id, status: PENDING_STATUS },
      data: {
        status: EXPIRED_STATUS,
        failureReason: "Proposal expired before reaching its signature threshold",
      },
    });

    if (count === 0) return false;

    await auditTx(tx, {
      userId: proposal.creatorId,
      groupId: proposal.groupId,
      action: "treasury_proposal.expired",
      entityType: "treasury_proposal",
      entityId: proposal.id,
      metadata: {
        from: PENDING_STATUS,
        to: EXPIRED_STATUS,
        // The age is what justifies the transition, so it is recorded rather
        // than left to be re-derived from timestamps later.
        ageMs: now.getTime() - proposal.createdAt.getTime(),
        source: "worker",
      },
    });

    return true;
  });
}
