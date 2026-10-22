/**
 * Settlement status reconciliation — settles the outcome of settlements the
 * submission job could not confirm.
 *
 * When a payment was submitted but Horizon had not shown it by the end of the
 * confirmation poll (or stopped answering), the submission job parks the
 * settlement in `needs_review` with its `stellarTxHash`. Nothing about that is
 * evidence of payment, and resubmitting could pay twice, so this task only
 * *reads* Horizon for that hash and resolves the row once the ledger answers:
 *
 *   found, successful                 → confirmed (share marked settled)
 *   found, failed                     → failed
 *   not found, envelope still valid   → stays needs_review, re-checked later
 *   not found, maxTime + grace passed → failed — the envelope can no longer
 *                                       be applied, so it never will be
 *   Horizon error                     → stays needs_review, re-checked later
 *
 * Each row is claimed with the same lease columns the submission job uses, so
 * two workers never resolve the same settlement, and `nextAttemptAt` spaces
 * re-checks out instead of querying Horizon every cycle.
 */

import pino from "pino";
import { config } from "../../config";
import { prisma } from "../../db";
import { stellar } from "../../services/stellar";
import { applySettlementTransition } from "../../services/settlement-machine";
import { recordStatusTransitionInTransaction } from "../../services/status-history";
import { jobContext, loggerWithContext } from "../../lib/correlation";

const log = pino({ name: "settlement-status-reconciliation" });

export type SettlementReconcileOutcome =
  | "confirmed"
  | "failed"
  | "pending"
  | "error"
  | "skipped";

export interface SettlementReconcileOptions {
  /** Identifies this process's leases. */
  workerId: string;
  batchSize?: number;
  leaseMs?: number;
  recheckDelayMs?: number;
  expiryGraceMs?: number;
  now?: () => Date;
}

interface ReconcileRow {
  id: string;
  stellarTxHash: string | null;
  expenseShareId: string | null;
  expiresAt: Date | null;
}

function resolveOptions(options: SettlementReconcileOptions) {
  return {
    workerId: options.workerId,
    batchSize: options.batchSize ?? config.WORKER_BATCH_SIZE,
    leaseMs: options.leaseMs ?? config.WORKER_LEASE_TIMEOUT_MS,
    recheckDelayMs: options.recheckDelayMs ?? config.SETTLEMENT_RECHECK_DELAY_MS,
    expiryGraceMs: options.expiryGraceMs ?? config.SETTLEMENT_EXPIRY_GRACE_MS,
    now: options.now ?? (() => new Date()),
  };
}

type Resolved = ReturnType<typeof resolveOptions>;

/** Rows due for a check: unresolved, hash known, not backed off, not leased. */
function dueWhere(now: Date) {
  return {
    status: "needs_review",
    stellarTxHash: { not: null },
    AND: [
      { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
    ],
  };
}

async function claim(row: ReconcileRow, opts: Resolved): Promise<boolean> {
  const now = opts.now();
  const { count } = await prisma.settlement.updateMany({
    where: { id: row.id, ...dueWhere(now) },
    data: {
      claimedBy: opts.workerId,
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + opts.leaseMs),
    },
  });
  return count === 1;
}

const releaseLease = { claimedBy: null, claimedAt: null, leaseExpiresAt: null };

/** Leave the row in needs_review and schedule the next check. */
async function scheduleRecheck(row: ReconcileRow, opts: Resolved, reason: string) {
  await prisma.settlement.updateMany({
    where: { id: row.id, claimedBy: opts.workerId },
    data: {
      ...releaseLease,
      nextAttemptAt: new Date(opts.now().getTime() + opts.recheckDelayMs),
      failureReason: reason,
    },
  });
}

async function resolve(
  row: ReconcileRow,
  hash: string,
  nextStatus: "confirmed" | "failed",
  reason: string | null
): Promise<void> {
  // The status change, its audit entry, its history row and the share update
  // commit together, so a crash can't confirm a settlement without settling
  // its share (or vice versa).
  await prisma.$transaction(async (tx) => {
    await applySettlementTransition({
      settlementId: row.id,
      nextStatus,
      source: "worker",
      tx,
      extraData: {
        ...releaseLease,
        stellarTxHash: hash,
        nextAttemptAt: null,
        errorCategory: nextStatus === "failed" ? "permanent" : null,
        failureReason: reason,
      },
    });
    await recordStatusTransitionInTransaction(tx, {
      entityType: "settlement",
      entityId: row.id,
      newStatus: nextStatus,
      reason: reason ?? undefined,
      source: "worker",
    });
    if (nextStatus === "confirmed" && row.expenseShareId) {
      await tx.expenseShare.update({
        where: { id: row.expenseShareId },
        data: { status: "settled" },
      });
    }
  });
}

/** Reconcile one already-claimed settlement against Horizon. */
async function reconcileClaimed(
  row: ReconcileRow,
  opts: Resolved
): Promise<SettlementReconcileOutcome> {
  const hash = row.stellarTxHash!;
  const jobLog = loggerWithContext(log, jobContext("settlement-reconciliation", row.id));

  let tx: { successful: boolean } | null;
  try {
    tx = await stellar.getTransaction(hash);
  } catch (error) {
    // Horizon not answering says nothing about the payment; look again later.
    const message = error instanceof Error ? error.message : String(error);
    await scheduleRecheck(row, opts, `Horizon lookup failed for ${hash}; will retry`);
    jobLog.warn({ jobId: row.id, hash, outcome: "error", reason: message }, "horizon lookup failed");
    return "error";
  }

  if (tx?.successful) {
    await resolve(row, hash, "confirmed", null);
    jobLog.info({ jobId: row.id, hash, outcome: "confirmed" }, "settlement confirmed by reconciliation");
    return "confirmed";
  }

  if (tx && !tx.successful) {
    await resolve(row, hash, "failed", `Transaction ${hash} failed on Stellar`);
    jobLog.error({ jobId: row.id, hash, outcome: "failed" }, "settlement transaction failed on Stellar");
    return "failed";
  }

  // Not visible. Once the envelope's maxTime (plus ingestion grace) has passed,
  // the network will reject it, so absence is final. Without a recorded expiry
  // there is no such proof, and the row keeps waiting for the ledger.
  const deadline = row.expiresAt ? row.expiresAt.getTime() + opts.expiryGraceMs : null;
  if (deadline !== null && opts.now().getTime() > deadline) {
    await resolve(
      row,
      hash,
      "failed",
      `Transaction ${hash} never appeared on Stellar before its time bounds expired`
    );
    jobLog.error({ jobId: row.id, hash, outcome: "failed" }, "settlement expired without landing");
    return "failed";
  }

  await scheduleRecheck(row, opts, `Awaiting on-chain confirmation for ${hash}`);
  jobLog.debug({ jobId: row.id, hash, outcome: "pending" }, "transaction not yet visible");
  return "pending";
}

/**
 * Run one reconciliation pass over due `needs_review` settlements.
 * Returns the outcome per settlement id, mainly for tests and logging.
 */
export async function reconcilePendingSettlementStatuses(
  options: SettlementReconcileOptions
): Promise<Record<string, SettlementReconcileOutcome>> {
  const opts = resolveOptions(options);

  const rows: ReconcileRow[] = await prisma.settlement.findMany({
    where: dueWhere(opts.now()),
    select: { id: true, stellarTxHash: true, expenseShareId: true, expiresAt: true },
    orderBy: { updatedAt: "asc" },
    take: opts.batchSize,
  });

  const outcomes: Record<string, SettlementReconcileOutcome> = {};

  for (const row of rows) {
    if (!(await claim(row, opts))) {
      outcomes[row.id] = "skipped";
      continue;
    }
    try {
      outcomes[row.id] = await reconcileClaimed(row, opts);
    } catch (error) {
      // An unexpected failure (e.g. the DB write) must not strand the lease or
      // stop the batch; the row is retried once the lease is released.
      outcomes[row.id] = "error";
      log.error(
        { jobId: row.id, outcome: "error", reason: error instanceof Error ? error.message : String(error) },
        "settlement reconciliation failed"
      );
      await prisma.settlement
        .updateMany({ where: { id: row.id, claimedBy: opts.workerId }, data: releaseLease })
        .catch(() => undefined);
    }
  }

  return outcomes;
}
