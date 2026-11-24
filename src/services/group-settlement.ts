/**
 * Group expense settlement orchestration with transactional audit logging.
 *
 * Wraps the settlement transaction block so that any failure triggers an
 * audit entry via `logActionTx` before the transaction is rolled back (#1128).
 * The audit log is intentionally part of the same transaction so it commits
 * or rolls back atomically with the settlement work — a partial settlement that
 * aborts mid-way leaves no dangling success record and no orphan failure log.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { logActionTx } from "./audit";
import { AuditAction } from "./audit-actions";
import { classifySettlementFailure, toSafeDetail } from "./settlement-failure";

export interface GroupSettlementParams {
  settlementId: string;
  groupId: string;
  actorId?: string | null;
  correlationId?: string | null;
}

/**
 * Execute group expense settlement work inside a Prisma transaction.
 *
 * On failure, records a `SETTLEMENT_FAILED` audit entry atomically within the
 * transaction (via `logActionTx`) before re-throwing so the transaction rolls
 * back. This guarantees every failure is traceable within the transaction
 * context, and the audit entry is never written without its corresponding
 * settlement state change (#1128).
 */
export async function executeGroupSettlement(
  params: GroupSettlementParams,
  work: (tx: Prisma.TransactionClient) => Promise<void>
): Promise<void> {
  const { settlementId, groupId, actorId, correlationId } = params;

  await prisma.$transaction(async (tx) => {
    try {
      await work(tx);
    } catch (error) {
      await logActionTx(tx, {
        actorId: actorId ?? null,
        groupId,
        action: AuditAction.SETTLEMENT_FAILED,
        resourceType: "settlement",
        resourceId: settlementId,
        correlationId: correlationId ?? null,
        outcome: "failure",
        metadata: {
          category: classifySettlementFailure(error).category,
          reason: toSafeDetail(error),
        },
      });
      throw error;
    }
  });
}
