import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { AuditAction } from "./audit-actions";
import {
  emitAuditEvent,
  sanitizeAuditMetadata,
} from "../lib/audit-logger";

/**
 * Console/file telemetry for the durable audit trail — Issues #367 and #131,
 * now flowing through the dedicated structured audit-event logger
 * (src/lib/audit-logger.ts) so every state-changing operation emits one
 * standardized JSON line with actor, action, target resource, and timestamp.
 *
 * The Prisma record remains the durable, queryable source of truth; the Pino
 * line is the streaming mirror for operators. Telemetry is strictly
 * best-effort: a logging failure must never fail — or roll back — the
 * operation the audit record documents.
 */
function emitTelemetry(data: ReturnType<typeof auditData>): void {
  emitAuditEvent({
    action: data.action,
    actorType: data.metadata?.actorType,
    userId: data.userId,
    actorPublicKey: data.metadata?.actorPublicKey,
    groupId: data.groupId,
    entityType: data.entityType ?? "unknown",
    entityId: data.entityId ?? "unknown",
    outcome: data.metadata?.outcome,
    metadata: data.metadata,
  });
}
/** Whether the audited action succeeded, for operator-facing filtering. */
export type AuditOutcome = "success" | "failure";

export const ADMIN_AUDIT_ACTIONS = {
  MEMBER_ROLE_UPDATED: "MEMBER_ROLE_UPDATED",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  MULTISIG_CONFIG_CHANGED: "MULTISIG_CONFIG_CHANGED",
} as const;
/** Actor type for distinguishing authenticated users from automated system actions. */
export type AuditActorType = "user" | "worker" | "system";

export interface AuditParams {
  userId?: string | null;
  groupId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  outcome?: AuditOutcome;
  actorType?: AuditActorType;
  /** Public Stellar key of the actor; private key material is never accepted. */
  actorPublicKey?: string | null;
  /** Safe, structured detail only — never private keys, bearer tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
}

/** Build the Prisma `data` payload for an audit record. */
export function auditData(params: AuditParams) {
  return {
    userId: params.userId ?? null,
    groupId: params.groupId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: {
      ...(sanitizeAuditMetadata(params.metadata ?? {}) as Record<string, unknown>),
      ...(params.outcome ? { outcome: params.outcome } : {}),
      ...(params.actorType ? { actorType: params.actorType } : {}),
      ...(params.actorPublicKey ? { actorPublicKey: params.actorPublicKey } : {}),
    } as any,
  };
}

/** Best-effort audit log write. Never throws into the request path. */
export async function audit(params: AuditParams): Promise<void> {
  try {
    const data = auditData(params);
    await prisma.auditLog.create({ data });
    emitTelemetry(data);
  } catch (err) {
    // Swallow — auditing outside a caller-managed transaction must not break
    // the operation — but surface the loss to telemetry so a silently failing
    // audit store stays visible to operators.
    try {
      // Reuse the structured schema so a silently failing audit store stays
      // visible to the same filters operators already use (`event = "audit"`,
      // `action`), with the failure itself recorded in metadata.
      emitAuditEvent({
        action: params.action,
        actorType: params.actorType,
        userId: params.userId,
        actorPublicKey: params.actorPublicKey,
        groupId: params.groupId,
        entityType: params.entityType,
        entityId: params.entityId,
        outcome: "failure",
        metadata: {
          audit_write_failed: true,
          reason: err instanceof Error ? err.message : "unknown error",
        },
      });
    } catch {
      // ignore — never throw into the request path
    }
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
  const data = auditData(params);
  await tx.auditLog.create({ data });
  // The row above commits (or rolls back) with the caller's transaction and is
  // the source of truth; the telemetry line merely mirrors the write for
  // operators and is best-effort.
  emitTelemetry(data);
}

export interface GroupMemberAuditParams {
  userId: string;
  groupId: string;
  memberId: string;
  action:
    | typeof AuditAction.GROUP_MEMBER_REMOVE
    | typeof AuditAction.GROUP_MEMBER_ROLE_CHANGE;
  metadata: Record<string, unknown>;
}

/** Write a canonical actor/group/member audit record within the mutation transaction. */
export function auditGroupMemberActionTx(
  tx: Prisma.TransactionClient,
  params: GroupMemberAuditParams
): Promise<void> {
  return auditTx(tx, {
    userId: params.userId,
    groupId: params.groupId,
    action: params.action,
    entityType: "group_member",
    entityId: params.memberId,
    outcome: "success",
    metadata: params.metadata,
  });
}
