import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { AuditAction } from "./audit-actions";
import {
  emitAuditEvent,
  sanitizeAuditMetadata,
} from "../lib/audit-logger";
import { isRecord, serializeAuditMetadata } from "../schemas/json-metadata";

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
  const { actorType, actorPublicKey, outcome } = data.metadata;
  emitAuditEvent({
    action: data.action,
    actorType:
      actorType === "user" || actorType === "worker" || actorType === "system"
        ? actorType
        : undefined,
    userId: data.userId,
    actorPublicKey:
      typeof actorPublicKey === "string" ? actorPublicKey : undefined,
    groupId: data.groupId,
    entityType: data.entityType ?? "unknown",
    entityId: data.entityId ?? "unknown",
    outcome:
      outcome === "success" || outcome === "failure" ? outcome : undefined,
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
  /** Per-request Fastify request id, or a job_-prefixed worker correlation id. */
  correlationId?: string | null;
  outcome?: AuditOutcome;
  actorType?: AuditActorType;
  /** Public Stellar key of the actor; private key material is never accepted. */
  actorPublicKey?: string | null;
  /** Safe, structured detail only — never private keys, bearer tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
}

/** Build the Prisma `data` payload for an audit record. */
export function auditData(params: AuditParams) {
  const sanitized = sanitizeAuditMetadata(params.metadata ?? {});
  return {
    userId: params.userId ?? null,
    groupId: params.groupId ?? null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    correlationId: params.correlationId ?? null,
    metadata: serializeAuditMetadata({
      ...(isRecord(sanitized) ? sanitized : {}),
      ...(params.outcome ? { outcome: params.outcome } : {}),
      ...(params.actorType ? { actorType: params.actorType } : {}),
      ...(params.actorPublicKey ? { actorPublicKey: params.actorPublicKey } : {}),
      ...(params.correlationId ? { correlationId: params.correlationId } : {}),
    }),
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

/**
 * Canonical audit-log write parameters — issue #660.
 *
 * The request-shaped sibling of {@link AuditParams}: it names the four facts
 * every audit row records — the actor, the action, the target resource, and
 * non-sensitive metadata — using the vocabulary of the issue
 * (`actorId`, `action`, `resourceType`/`resourceId`, `metadata`). Internally
 * it maps onto the same `audit_logs` columns (`userId`, `action`,
 * `entityType`/`entityId`, `metadata`) through {@link logAction}, so route
 * handlers have one obvious entry point and every row lands one shape.
 */
export interface LogActionParams {
  /** `User.id` of the actor. Null (or omitted) for worker/system actions. */
  actorId?: string | null;
  /** Actor's Stellar public key — public material only, never a secret key. */
  actorPublicKey?: string | null;
  actorType?: AuditActorType;
  /** Group the action belongs to, when the action is group-scoped. */
  groupId?: string | null;
  /** Per-request Fastify request id, or a job_-prefixed worker correlation id. */
  correlationId?: string | null;
  /** Action type from the structured vocabulary (src/services/audit-actions.ts). */
  action: string;
  /** Target resource type, e.g. "group", "group_member", "expense", "settlement". */
  resourceType: string;
  /** Target resource id. */
  resourceId: string;
  outcome?: AuditOutcome;
  /** Safe structured detail only — never private keys, tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
}

/** Map the issue-shaped params onto the repository's persisted column names. */
function toAuditParams(params: LogActionParams): AuditParams {
  return {
    userId: params.actorId ?? null,
    groupId: params.groupId ?? null,
    action: params.action,
    entityType: params.resourceType,
    entityId: params.resourceId,
    correlationId: params.correlationId ?? null,
    outcome: params.outcome,
    actorType: params.actorType,
    actorPublicKey: params.actorPublicKey ?? null,
    metadata: params.metadata,
  };
}

/**
 * Record one state-changing action in the durable audit trail (issue #660).
 *
 * This is the canonical audit entry point for route handlers: it persists the
 * actor, action type, target resource, and sanitized metadata to the
 * `audit_logs` table and mirrors the event to the structured Pino auditor
 * (src/lib/audit-logger.ts). Like {@link audit}, it is best-effort — a failed
 * audit write never fails (or rolls back) the operation it documents.
 *
 * Actions that must be atomic with the mutation they describe use
 * {@link logActionTx} inside the caller's transaction instead.
 */
export async function logAction(params: LogActionParams): Promise<void> {
  await audit(toAuditParams(params));
}

/**
 * Record one state-changing action inside an existing transaction, so the
 * audit row commits — or rolls back — with the mutation itself. Unlike
 * {@link logAction}, this deliberately propagates a write failure: a caller
 * that asked for an atomic audit trail must not silently lose it.
 */
export async function logActionTx(
  tx: Prisma.TransactionClient,
  params: LogActionParams
): Promise<void> {
  await auditTx(tx, toAuditParams(params));
}

/**
 * Record one state-changing action **without** delaying the response —
 * issue #914's `logAuditTrail`.
 *
 * `logAction` / `logActionTx` are awaited by handlers that need their record
 * to be durable before they answer (or to commit with the mutation). This is
 * the non-blocking sibling for request paths where the row is observational:
 * it starts the same sanitized, best-effort write and returns synchronously,
 * so a database round trip never sits on the HTTP latency path. The write is
 * scheduled rather than dropped — it still runs — and a failure surfaces only
 * in the structured audit-event stream (src/lib/audit-logger.ts), never to the
 * caller.
 *
 * Reach for {@link logActionTx} whenever the record must commit — or roll
 * back — with the mutation it documents; use this when the mutation is
 * already complete and the audit row only has to exist.
 */
export function logAuditTrail(params: LogActionParams): void {
  // `audit` never rejects (it catches and mirrors its own failure), so the
  // floating promise cannot become an unhandled rejection.
  void audit(toAuditParams(params));
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
  params: GroupMemberAuditParams & { correlationId?: string | null }
): Promise<void> {
  return auditTx(tx, {
    userId: params.userId,
    groupId: params.groupId,
    action: params.action,
    entityType: "group_member",
    entityId: params.memberId,
    correlationId: params.correlationId ?? null,
    outcome: "success",
    metadata: params.metadata,
  });
}

export interface MultisigAuditParams {
  userId?: string | null;
  groupId: string;
  proposalId: string;
  action:
    | typeof AuditAction.TREASURY_PROPOSAL_CREATED
    | typeof AuditAction.TREASURY_PROPOSAL_SIGNED
    | typeof AuditAction.TREASURY_PROPOSAL_SUBMITTED
    | typeof AuditAction.TREASURY_PROPOSAL_EXPIRED
    | typeof AuditAction.TREASURY_PROPOSAL_FAILED
    | typeof AuditAction.TREASURY_TX_PROPOSAL_CREATED
    | typeof AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED
    | typeof AuditAction.TREASURY_TX_PROPOSAL_READY
    | typeof AuditAction.TREASURY_TX_PROPOSAL_SUBMITTED
    | typeof AuditAction.TREASURY_TX_PROPOSAL_FAILED
    | string;
  /**
   * Target resource type. Defaults to `treasury_proposal` (the server-built
   * payment flow); the signature-collector flow passes `treasury_tx_proposal`
   * so both tables' rows are attributable to the right resource.
   */
  entityType?: "treasury_proposal" | "treasury_tx_proposal" | string;
  actorPublicKey?: string | null;
  correlationId?: string | null;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Transactional audit logging helper for treasury multisig operations.
 * Records multisig proposal creation, signature collection, and submission
 * events atomically within the same transaction as the state change, in one
 * standardized shape: actor (user id + public key), group, action, target
 * proposal, outcome, and sanitized metadata (see src/lib/audit-logger.ts,
 * which redacts private keys, tokens, and signed envelopes).
 *
 * Both multisig services use this helper so a signature-collector event and a
 * server-built-proposal event land the same columns and mirror the same Pino
 * audit schema, differing only in `entityType` and the action vocabulary of
 * their flow.
 */
export async function auditMultisigActionTx(
  tx: Prisma.TransactionClient,
  params: MultisigAuditParams
): Promise<void> {
  await auditTx(tx, {
    userId: params.userId ?? null,
    groupId: params.groupId,
    actorPublicKey: params.actorPublicKey ?? null,
    action: params.action,
    entityType: params.entityType ?? "treasury_proposal",
    entityId: params.proposalId,
    correlationId: params.correlationId ?? null,
    outcome: params.outcome ?? "success",
    metadata: params.metadata,
  });
}
export interface GroupExpenseMutationAuditParams {
  userId?: string | null;
  actorPublicKey?: string | null;
  clientIp?: string | null;
  groupId: string;
  action: string;
  entityType: "group" | "expense" | "settlement" | "group_member";
  entityId: string;
  correlationId?: string | null;
  outcome?: AuditOutcome;
  metadata?: Record<string, unknown>;
}

/**
 * Structured audit logging helper for state-changing group and expense operations (#903).
 * Records mutations with actor credentials, client IP, target entity, and sanitized metadata.
 */
export async function auditGroupExpenseMutation(
  params: GroupExpenseMutationAuditParams
): Promise<void> {
  await audit({
    userId: params.userId ?? null,
    actorPublicKey: params.actorPublicKey ?? null,
    groupId: params.groupId,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    correlationId: params.correlationId ?? null,
    outcome: params.outcome ?? "success",
    actorType: params.userId ? "user" : "system",
    metadata: {
      ...(params.clientIp ? { clientIp: params.clientIp } : {}),
      ...(params.metadata ?? {}),
    },
  });
}


export interface SettlementAuditParams {
  userId: string;
  actorPublicKey?: string | null;
  groupId: string;
  settlementId: string;
  amount: string;
  assetCode: string;
  toUserId?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log helper for group expense settlement initiation (#884).
 * Records the actor's public key, action type, target group, and settlement id.
 */
export async function auditSettlementInitiated(
  params: SettlementAuditParams,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const auditPayload: AuditParams = {
    userId: params.userId,
    actorPublicKey: params.actorPublicKey ?? null,
    groupId: params.groupId,
    action: AuditAction.SETTLEMENT_CREATED,
    entityType: "settlement",
    entityId: params.settlementId,
    correlationId: params.correlationId ?? null,
    outcome: "success",
    actorType: "user",
    metadata: {
      amount: params.amount,
      assetCode: params.assetCode,
      ...(params.toUserId ? { toUserId: params.toUserId } : {}),
      ...(params.metadata ?? {}),
    },
  };
  if (tx) {
    await auditTx(tx, auditPayload);
  } else {
    await audit(auditPayload);
  }
}

export interface SettlementFinalizeAuditParams {
  userId: string;
  actorPublicKey?: string | null;
  groupId: string;
  settlementId: string;
  status: "confirmed" | "completed" | "submitted" | "failed";
  stellarTxHash?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log helper for group expense settlement finalization (#884).
 * Records settlement completion or failure with actor credentials and transaction hash.
 */
export async function auditSettlementFinalized(
  params: SettlementFinalizeAuditParams,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const isFailed = params.status === "failed";
  const auditPayload: AuditParams = {
    userId: params.userId,
    actorPublicKey: params.actorPublicKey ?? null,
    groupId: params.groupId,
    action: isFailed ? AuditAction.SETTLEMENT_FAILED : AuditAction.SETTLEMENT_CONFIRMED,
    entityType: "settlement",
    entityId: params.settlementId,
    correlationId: params.correlationId ?? null,
    outcome: isFailed ? "failure" : "success",
    actorType: "user",
    metadata: {
      status: params.status,
      ...(params.stellarTxHash ? { stellarTxHash: params.stellarTxHash } : {}),
      ...(params.metadata ?? {}),
    },
  };
  if (tx) {
    await auditTx(tx, auditPayload);
  } else {
    await audit(auditPayload);
  }
}

export interface TreasurySignerChangeAuditParams {
  userId: string;
  actorPublicKey?: string | null;
  groupId: string;
  treasuryAccountPublicKey: string;
  requiredSigners: number;
  previousRequiredSigners?: number | null;
  signers?: Array<{ publicKey: string; weight: number }>;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Audit log helper for treasury multisig configuration and signer modifications (#884).
 * Records modifications to treasury signers and required signer thresholds.
 */
export async function auditTreasurySignerChange(
  params: TreasurySignerChangeAuditParams,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const auditPayload: AuditParams = {
    userId: params.userId,
    actorPublicKey: params.actorPublicKey ?? null,
    groupId: params.groupId,
    action: AuditAction.TREASURY_SIGNER_UPDATE,
    entityType: "group",
    entityId: params.groupId,
    correlationId: params.correlationId ?? null,
    outcome: "success",
    actorType: "user",
    metadata: {
      treasuryAccountPublicKey: params.treasuryAccountPublicKey,
      requiredSigners: params.requiredSigners,
      previousRequiredSigners: params.previousRequiredSigners ?? null,
      ...(params.signers ? { signers: params.signers } : {}),
      ...(params.metadata ?? {}),
    },
  };
  if (tx) {
    await auditTx(tx, auditPayload);
  } else {
    await audit(auditPayload);
  }
}

export interface GroupAdminAuditParams {
  actorId: string;
  groupId: string;
  action: string;
  targetResourceId: string;
  targetResourceType?: string;
  actorPublicKey?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
  outcome?: AuditOutcome;
}

/**
 * Audit log helper for state-changing group admin actions (#801).
 * Records administrator operations (member removal, settings updates, role changes)
 * with sanitized metadata, executing without blocking the main request/response flow.
 */
export async function auditGroupAdminAction(
  params: GroupAdminAuditParams,
  tx?: Prisma.TransactionClient
): Promise<void> {
  const sanitized = sanitizeAuditMetadata(params.metadata ?? {});
  const auditPayload: AuditParams = {
    userId: params.actorId,
    actorPublicKey: params.actorPublicKey ?? null,
    groupId: params.groupId,
    action: params.action,
    entityType: params.targetResourceType ?? "group",
    entityId: params.targetResourceId,
    correlationId: params.correlationId ?? null,
    outcome: params.outcome ?? "success",
    actorType: "user",
    metadata: {
      adminAction: true,
      timestamp: new Date().toISOString(),
      ...(isRecord(sanitized) ? sanitized : {}),
    },
  };

  if (tx) {
    await auditTx(tx, auditPayload);
  } else {
    await audit(auditPayload);
  }
}
