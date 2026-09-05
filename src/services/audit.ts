import type { Prisma } from "@prisma/client";
import { prisma } from "../db";

const SENSITIVE_KEYS = new Set([
  "privatekey",
  "secretkey",
  "signedxdr",
  "transactionxdr",
  "xdr",
  "token",
  "jwt",
  "authorization",
  "password",
  "secret",
]);

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_KEYS.has(key.toLowerCase()))
      .map(([key, item]) => [key, sanitize(item)])
  );
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
      ...(sanitize(params.metadata ?? {}) as Record<string, unknown>),
      ...(params.outcome ? { outcome: params.outcome } : {}),
      ...(params.actorType ? { actorType: params.actorType } : {}),
    } as any,
  };
}

/** Best-effort audit log write. Never throws into the request path. */
export async function audit(params: AuditParams): Promise<void> {
  try {
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
