import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

export interface AuditParams {
  userId?: string | null;
  groupId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  outcome?: AuditOutcome;
  /** Safe, structured detail only — never private keys, bearer tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
}

/** Build the Prisma `data` payload for an audit record. */
export function auditData(params: AuditParams) {
  return {
    userId: params.userId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: (params.metadata ?? undefined) as any,
  };
}

/** Best-effort audit log write. Never throws into the request path. */
export async function audit(params: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId ?? null,
        groupId: params.groupId ?? null,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        metadata: (params.metadata ?? undefined) as any,
      },
    });
    await prisma.auditLog.create({ data: auditData(params) });
  } catch {
    // swallow — auditing outside a caller-managed transaction must not break the operation
  }
}

/**
 * Write an audit record as part of an existing transaction. Unlike `audit`,
 * this intentionally does NOT swallow errors: callers use this precisely
 * because they need the audit entry to be atomic with the state change it
 * documents (e.g. a status transition) — if the audit write fails, the
 * whole transaction must roll back rather than silently losing the record.
 */
export async function auditTx(
  tx: Prisma.TransactionClient,
  params: AuditParams
): Promise<void> {
  await tx.auditLog.create({ data: auditData(params) });
}
