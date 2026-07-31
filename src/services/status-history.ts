import { prisma } from "../db";

/**
 * Centralized service for recording status transitions with history.
 * This ensures all status changes are logged atomically and consistently
 * across the API and worker.
 */

export interface StatusTransitionParams {
  entityType: "settlement" | "anchor_session";
  entityId: string;
  newStatus: string;
  reason?: string;
  source?: string;
}

/**
 * Record a status transition with history entry.
 * This should be called within a transaction when updating the parent record.
 */
export async function recordStatusTransition(params: StatusTransitionParams) {
  const { entityType, entityId, newStatus, reason, source } = params;

  // Check if this would be a duplicate (same status for same entity)
  const latestHistory = await prisma.statusHistory.findFirst({
    where: {
      entityType,
      entityId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  // Skip if the status hasn't changed
  if (latestHistory && latestHistory.status === newStatus) {
    return latestHistory;
  }

  // Create new history entry
  return prisma.statusHistory.create({
    data: {
      entityType,
      entityId,
      status: newStatus,
      reason,
      source,
    },
  });
}

/**
 * Get status history for an entity, ordered by creation time (newest first).
 */
export async function getStatusHistory(params: {
  entityType: "settlement" | "anchor_session";
  entityId: string;
  limit?: number;
}) {
  const { entityType, entityId, limit = 50 } = params;

  return prisma.statusHistory.findMany({
    where: {
      entityType,
      entityId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: limit,
  });
}

/**
 * Record a status transition within a transaction.
 * Use this when updating the parent record atomically.
 */
export async function recordStatusTransitionInTransaction(
  tx: any,
  params: StatusTransitionParams
) {
  const { entityType, entityId, newStatus, reason, source } = params;

  // Check for duplicate within the transaction
  const latestHistory = await tx.statusHistory.findFirst({
    where: {
      entityType,
      entityId,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  if (latestHistory && latestHistory.status === newStatus) {
    return latestHistory;
  }

  return tx.statusHistory.create({
    data: {
      entityType,
      entityId,
      status: newStatus,
      reason,
      source,
    },
  });
}
