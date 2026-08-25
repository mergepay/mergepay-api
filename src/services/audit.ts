import type { Prisma } from "@prisma/client";
import pino from "pino";
import { prisma } from "../db";

const log = pino({ name: "audit" });

/** Whether the audited action succeeded, for operator-facing filtering. */
export type AuditOutcome = "success" | "failure" | "rejected";

/**
 * Who/what performed the action.
 *
 *   "user"   — an authenticated request; `userId` must be set.
 *   "worker" — a background job (settlement submission, anchor polling,
 *              reconciliation) acting without a human in the loop.
 *   "system" — any other non-interactive process.
 *
 * `userId` is a real foreign key to `User`, so a synthetic id (e.g.
 * `"system"`) can never be stored there — this field is the actor identity
 * for non-user events instead, so a worker/system action is never recorded
 * with a blank or ambiguous actor.
 */
export type AuditActorType = "user" | "worker" | "system";

export interface AuditParams {
  userId?: string | null;
  groupId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  outcome?: AuditOutcome;
  /**
   * Who performed the action. Defaults to `"user"` when `userId` is set and
   * `"system"` otherwise, so a caller that forgets to pass this for a
   * worker-driven event still gets a labeled (never-blank) actor rather than
   * a bare null. Pass `"worker"` explicitly from job/reconciliation code so
   * it's distinguishable from other non-interactive callers.
   */
  actorType?: AuditActorType;
  /** Safe, structured detail only — never private keys, bearer tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
}

/**
 * Key names that must never appear anywhere in an audit `metadata` payload
 * (checked case-insensitively, at any nesting depth). This is the runtime
 * backstop for "never store private keys, signed XDRs, auth tokens, or
 * unnecessary personal data" — callers are still expected to pass an
 * intentionally small, documented metadata shape (see the action vocabulary
 * in src/services/audit-actions.ts), not to rely on this list catching
 * everything.
 */
const FORBIDDEN_METADATA_KEYS = new Set([
  "privatekey",
  "secretkey",
  "seed",
  "mnemonic",
  "signedxdr",
  "transactionxdr",
  "xdr",
  "envelope",
  "signature",
  "signatures",
  "token",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "authorization",
  "bearer",
  "password",
  "secret",
  "cookie",
]);

/** Throws if `metadata` contains a forbidden key at any depth. */
function assertSafeMetadata(metadata: Record<string, unknown> | undefined, path = ""): void {
  if (!metadata) return;
  for (const [key, value] of Object.entries(metadata)) {
    const fullPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_METADATA_KEYS.has(key.toLowerCase())) {
      throw new Error(`audit metadata contains a forbidden key: ${fullPath}`);
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      assertSafeMetadata(value as Record<string, unknown>, fullPath);
    }
  }
}

/** Build the Prisma `data` payload for an audit record. */
export function auditData(params: AuditParams) {
  assertSafeMetadata(params.metadata);

  const actorType: AuditActorType = params.actorType ?? (params.userId ? "user" : "system");

  return {
    userId: params.userId ?? null,
    groupId: params.groupId ?? null,
    action: params.action,
    actorType,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: {
      ...(params.metadata ?? {}),
      ...(params.outcome ? { outcome: params.outcome } : {}),
    } as any,
  };
}

/**
 * Best-effort audit log write. Never throws into the request path.
 *
 * A failure here (including a metadata safety-check failure) is logged with
 * the action/actor/target only — never the metadata payload itself, since a
 * safety-check failure is precisely the case where that payload might carry
 * something sensitive.
 */
export async function audit(params: AuditParams): Promise<void> {
  try {
    await prisma.auditLog.create({ data: auditData(params) });
  } catch (err) {
    log.error(
      {
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        userId: params.userId ?? null,
        reason: err instanceof Error ? err.message : String(err),
      },
      "audit write failed"
    );
  }
}

/**
 * Write an audit record as part of an existing transaction. Unlike `audit`,
 * this intentionally does NOT swallow errors: callers use this precisely
 * because they need the audit entry to be atomic with the state change it
 * documents (e.g. a status transition) — if the audit write fails (including
 * a metadata safety-check failure), the whole transaction must roll back
 * rather than silently losing the record or leaking sensitive data.
 */
export async function auditTx(
  tx: Prisma.TransactionClient,
  params: AuditParams
): Promise<void> {
  await tx.auditLog.create({ data: auditData(params) });
}
