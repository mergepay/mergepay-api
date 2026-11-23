/**
 * Background worker task for expiring stale settlement intents (#910).
 *
 * Unsettled group expenses or pending payment intents that exceed their
 * expiration window are automatically marked as EXPIRED by this task.
 * Updates are atomic with audit logs to ensure accurate group state.
 */
import type { Prisma } from "@prisma/client";
import { config } from "../config";
import { prisma } from "../db";
import { auditTx } from "../services/audit";

export const SETTLEMENT_INTENT_EXPIRED_STATUS = "EXPIRED";
export const SETTLEMENT_INTENT_PENDING_STATUS = "PENDING";

export interface ExpireSettlementIntentsResult {
  expired: number;
  cutoff: Date;
}

/** Default settlement intent TTL: 24 hours in milliseconds. */
export const DEFAULT_SETTLEMENT_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

export function settlementIntentExpiryCutoff(
  now: Date = new Date(),
  ttlMs: number = DEFAULT_SETTLEMENT_INTENT_TTL_MS
): Date {
  return new Date(now.getTime() - ttlMs);
}

/**
 * Sweep pending settlements older than the TTL and mark them EXPIRED.
 */
export async function expireStaleSettlementIntents(params: {
  now?: Date;
  ttlMs?: number;
  batchSize?: number;
} = {}): Promise<ExpireSettlementIntentsResult> {
  const {
    now = new Date(),
    ttlMs = DEFAULT_SETTLEMENT_INTENT_TTL_MS,
    batchSize = config.WORKER_BATCH_SIZE ?? 50,
  } = params;

  const cutoff = settlementIntentExpiryCutoff(now, ttlMs);

  const staleSettlements = await prisma.settlement.findMany({
    where: {
      status: SETTLEMENT_INTENT_PENDING_STATUS,
      createdAt: { lt: cutoff },
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    select: {
      id: true,
      fromUserId: true,
      toUserId: true,
      createdAt: true,
    },
  });

  let expired = 0;

  for (const s of staleSettlements) {
    const changed = await expireOneSettlement(s, now);
    if (changed) expired += 1;
  }

  return { expired, cutoff };
}

async function expireOneSettlement(
  settlement: { id: string; fromUserId: string; toUserId: string; createdAt: Date },
  now: Date
): Promise<boolean> {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const { count } = await tx.settlement.updateMany({
      where: { id: settlement.id, status: SETTLEMENT_INTENT_PENDING_STATUS },
      data: {
        status: SETTLEMENT_INTENT_EXPIRED_STATUS,
      },
    });

    if (count === 0) return false;

    await auditTx(tx, {
      userId: settlement.fromUserId,
      actorType: "worker",
      action: "settlement.failed",
      entityType: "settlement",
      entityId: settlement.id,
      correlationId: `job_expire_settlement_${settlement.id}`,
      outcome: "failure",
      metadata: {
        reason: "Settlement payment intent expired before on-chain execution",
        from: SETTLEMENT_INTENT_PENDING_STATUS,
        to: SETTLEMENT_INTENT_EXPIRED_STATUS,
        ageMs: now.getTime() - settlement.createdAt.getTime(),
        source: "worker",
      },
    });

    return true;
  });
}
