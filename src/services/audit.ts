import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";

/**
 * Inventory of state-changing routes and worker transitions and the audit
 * action each one writes. Keeping this as a typed const (rather than a
 * separate doc) means it can't drift from the call sites that use it.
 */
export const AuditAction = {
  GroupCreate: "group.create",
  GroupInviteDirect: "group.invite",
  GroupInviteCodeCreate: "group.invite_code.create",
  GroupJoin: "group.join",
  GroupLeave: "group.leave",
  GroupArchive: "group.archive",

  ExpenseCreate: "expense.create",
  ExpenseUpdate: "expense.update",
  ExpenseDelete: "expense.delete",

  SettlementCreate: "settlement.create",
  SettlementConfirm: "settlement.confirm",
  SettlementConfirmDuplicate: "settlement.confirm.duplicate",
  SettlementSubmitted: "settlement.submitted",
  SettlementFailed: "settlement.failed",
  SettlementXdrRejected: "settlement.xdr_rejected",

  TreasuryEnable: "treasury.enable",
  TreasuryDepositCreate: "treasury.deposit.create",
  TreasuryWithdrawCreate: "treasury.withdraw.create",
  TreasuryConfirm: "treasury.confirm",
  TreasuryConfirmFailed: "treasury.confirm.failed",

  AnchorSessionStart: "anchor.session.start",
  AnchorSessionComplete: "anchor.session.complete",
  AnchorWebhookStatusChange: "anchor.webhook.status_change",
  AnchorReconcileStatusChange: "anchor.reconcile.status_change",

  InviteExpired: "invite.expired",
  IdempotencyKeyCleanup: "idempotency_key.cleanup",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Who performed the mutation: an authenticated user, or a named background worker. */
export type AuditActor =
  | { type: "user"; userId: string }
  | { type: "system"; worker: string };

export type AuditOutcome = "success" | "failure" | "denied" | "duplicate";

type AuditClient = PrismaClient | Prisma.TransactionClient;

export interface AuditParams {
  actor: AuditActor;
  action: AuditAction | (string & {});
  entityType: string;
  entityId: string;
  outcome?: AuditOutcome;
  /** Safe, structured detail only — never private keys, bearer tokens, or signed XDRs. */
  metadata?: Record<string, unknown>;
}

/**
 * Write an audit log entry.
 *
 * Pass `client` (the `tx` handed to a `prisma.$transaction(async (tx) => ...)`
 * callback) to make the write atomic with the mutation it documents — a
 * failure then rolls back the whole transaction instead of silently
 * dropping the audit record. Without `client`, the write is best-effort so a
 * logging outage never blocks the caller's request.
 */
export async function audit(params: AuditParams, client?: AuditClient): Promise<void> {
  const data = {
    userId: params.actor.type === "user" ? params.actor.userId : null,
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    metadata: {
      ...(params.metadata ?? {}),
      actor:
        params.actor.type === "system"
          ? { type: "system" as const, worker: params.actor.worker }
          : { type: "user" as const },
      outcome: params.outcome ?? "success",
    } as Prisma.InputJsonValue,
  };

  if (client) {
    await client.auditLog.create({ data });
    return;
  }

  try {
    await prisma.auditLog.create({ data });
  } catch {
    // swallow — auditing outside a caller-managed transaction must not break the operation
  }
}
