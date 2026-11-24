/**
 * SEP-24 audit vocabulary and metadata helpers (issue #1079).
 *
 * Deposit and withdrawal callbacks arrive from several surfaces (HMAC webhook,
 * signed anchor JWT, shared-secret webhook, and polling). Every surface builds
 * its audit payload here so one kind of event writes the same action and the
 * same set of traceable facts: transaction hash, asset code, amount, and the
 * account's public key. Only public data is ever accepted — an anchor token,
 * JWT, or private key is never a field of these helpers.
 */
import { prisma } from "../db";
import type { Sep24Callback } from "../schemas/sep24";
import { AuditAction } from "./audit-actions";
import { SEP24_TERMINAL_STATUSES } from "./sep24-types";

/** Whether a session describes an outbound withdrawal rather than a deposit. */
export function isWithdrawalKind(kind: string | null | undefined): boolean {
  return kind === "withdrawal";
}

/** Lifecycle action for the start of an interactive SEP-24 flow. */
export function sep24StartAction(kind: "deposit" | "withdrawal"): string {
  return kind === "withdrawal"
    ? AuditAction.ANCHOR_WITHDRAWAL_STARTED
    : AuditAction.ANCHOR_DEPOSIT_STARTED;
}

/**
 * Lifecycle action for a status transition, when the state is meaningful
 * enough to deserve its own event name. Intermediate states keep the generic
 * session transition action.
 */
export function sep24LifecycleAction(
  kind: string | null | undefined,
  status: string
): string | undefined {
  const withdrawal = isWithdrawalKind(kind);
  if (status === "completed") {
    return withdrawal
      ? AuditAction.ANCHOR_WITHDRAWAL_COMPLETED
      : AuditAction.ANCHOR_DEPOSIT_COMPLETED;
  }
  if ((SEP24_TERMINAL_STATUSES as readonly string[]).includes(status)) {
    return withdrawal
      ? AuditAction.ANCHOR_WITHDRAWAL_FAILED
      : AuditAction.ANCHOR_DEPOSIT_FAILED;
  }
  return undefined;
}

/** Safe, structured callback facts to attach to an audit row. */
export function sep24CallbackAuditMetadata(
  callback: Sep24Callback
): Record<string, unknown> {
  const metadata: Record<string, unknown> = { rawStatus: callback.rawStatus };
  const fields = {
    stellarTransactionId: callback.stellarTransactionId,
    amountIn: callback.amountIn,
    amountOut: callback.amountOut,
    amountFee: callback.amountFee,
  } as const;
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.trim().length > 0) {
      metadata[field] = value.trim();
    }
  }
  return metadata;
}

/** Safe, structured facts from a validated `GET /transaction` anchor response. */
export function anchorTransactionAuditMetadata(transaction: {
  status: string;
  stellar_transaction_id?: string | null;
  amount_in?: string | null;
  amount_out?: string | null;
  amount_fee?: string | null;
  amount_in_asset?: string | null;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = { rawStatus: transaction.status };
  const fields = {
    stellarTransactionId: transaction.stellar_transaction_id,
    amountIn: transaction.amount_in,
    amountOut: transaction.amount_out,
    amountFee: transaction.amount_fee,
    assetCode: transaction.amount_in_asset,
  } as const;
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === "string" && value.trim().length > 0) {
      metadata[field] = value.trim();
    }
  }
  return metadata;
}

/**
 * Resolve session owners' public Stellar keys for audit attribution.
 *
 * Delegates are optional-chained so the helper degrades to no attribution
 * rather than throwing when a unit test supplies a partial Prisma mock; the
 * production client always exposes `user.findMany`.
 */
export async function accountPublicKeys(
  userIds: readonly string[]
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const users = await prisma.user?.findMany?.({
    where: { id: { in: ids } },
    select: { id: true, stellarPublicKey: true },
  });
  return new Map((users ?? []).map((user) => [user.id, user.stellarPublicKey]));
}
