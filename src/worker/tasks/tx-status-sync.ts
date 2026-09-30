/**
 * Sync pending Stellar transaction statuses against Horizon (issue #355).
 *
 * Mergepay can hand an envelope to the ledger but cannot always observe the
 * outcome: a confirming response can be lost, a worker can die between
 * acceptance and the poll that follows it, or a member can sign an intent in
 * their own wallet and submit it directly with the row's `MP:<code>` memo. In
 * every case the database still says "in flight" while the ledger already
 * knows the answer. This job is the reader that closes the gap — it picks up
 * the pending rows that carry an on-chain hash, asks Horizon which of
 * {confirmed, failed, still silent} each one reached, and writes the answer
 * back through the same guarded Prisma updates the rest of the worker uses.
 *
 * What it covers — and what it deliberately leaves to its siblings:
 *
 *  settlement `verifying` with a recorded hash
 *      Submitted and hashed, but the confirmation poll that follows
 *      submission (see `confirmSubmission` in src/worker/index.ts) never
 *      finished: the process restarted or Horizon went quiet mid-poll. The
 *      submission job re-submits rather than reads, and the
 *      pending_confirmation/needs_review reconciliation job only selects
 *      those two statuses, so an interrupted poll leaves exactly this slice
 *      unwatched. Rows are only picked up once they are older than
 *      {@link STATUS_SYNC_MIN_AGE_MS}, so a poll that is still running
 *      normally is never raced by this job.
 *
 *  treasury_transaction `pending` / `awaiting_signatures` with a live intent
 *      The deposit/withdrawal intent records the envelope hash up front as
 *      `intendedTxHash` — the hash of the signature-independent envelope, so
 *      it is also the hash of the signed payment once anyone submits it. A
 *      payment a member signed and submitted from their own wallet therefore
 *      shows up under that hash even though the confirm endpoint was never
 *      called. Rows expired for longer than {@link STATUS_SYNC_EXPIRED_GRACE_MS}
 *      are skipped: an envelope past its time bounds can never be included,
 *      so polling it can only produce noise. The grace window exists because
 *      a transaction that landed moments before its deadline stays visible on
 *      the ledger afterwards and must still be recorded.
 *
 * Retry policy: every Horizon read runs through {@link withHorizonRetry},
 * which classifies each failure — rate limits (429), 5xx responses, and
 * transport errors are retried with jittered backoff, timeouts are treated as
 * indeterminate and retried too, and a permanent rejection stops immediately.
 * When the budget runs out the row is left exactly as it was and the next
 * cycle tries again, so one slow or rate-limited Horizon can never fail a
 * batch or wedge a record. A Horizon that never answers writes nothing: only
 * an observed on-chain outcome — or a transaction that provably does not
 * match the stored intent — changes state. The treasury slice keeps no retry
 * counters of its own; the settlement slice runs inside the shared bounded
 * budget of the reconciliation it delegates to.
 *
 * Writes are compare-and-set: settlements go through the settlement state
 * machine, which settles the linked expense share and writes the audit row in
 * one transaction, and treasury rows are updated with a conditional
 * `updateMany` that only lands while the row is still pending — two workers
 * racing the same record produce exactly one write.
 *
 * Progress is logged with Pino under the `transaction-status-sync` logger:
 * one line per record that changed, one warning per deferred record, and one
 * `batch_synced` summary per cycle, each carrying jobType, jobId, outcome and
 * a scrubbed reason — never an XDR, memo secret, or token.
 */
import { randomUUID } from "node:crypto";
import pino from "pino";
import { config } from "../../config";
import { prisma } from "../../db";
import { AppError, Errors } from "../../errors";
import {
  type CorrelationContext,
  jobContext,
  loggerWithContext,
} from "../../lib/correlation";
import { audit } from "../../services/audit";
import { AuditAction } from "../../services/audit-actions";
import { safeFailureMessage } from "../../services/job-retry";
import {
  getTransactionPayments,
  verifyPaymentOperation,
  verifyTransactionMemo,
} from "../../services/horizonService";
import {
  HORIZON_RETRY_POLICY,
  isRetrySuccess,
  withHorizonRetry,
} from "../../services/horizon-retry";
import {
  RECONCILIATION_MAX_RETRIES,
  reconcileSingleSettlement,
} from "../../services/settlement-reconciliation";
import { stellar } from "../../services/stellar";
import { TimeoutError, TransportError } from "../../services/timeout";

const log = pino({ name: "transaction-status-sync" });

/**
 * Identifies this process in settlement leases, so a claim taken here is only
 * ever released by the worker that took it.
 */
const SYNC_WORKER_ID = randomUUID();

/** Structured `jobType` carried by every line this job logs. */
export const TX_STATUS_SYNC_JOB = "tx_status_sync";

/**
 * How long a row must have been sitting still before this job touches it.
 *
 * A settlement inside this window is still being driven by the fast path —
 * submission plus its bounded confirmation poll — and a fresh treasury intent
 * has not had time to be signed or submitted yet. The window only has to
 * exceed the poll budget (CONFIRM_POLL_MAX_ATTEMPTS × CONFIRM_POLL_DELAY_MS),
 * so an interrupted poll is picked up on the first cycle after it stalls.
 */
export const STATUS_SYNC_MIN_AGE_MS = 60_000;

/**
 * How long past its deadline an intent is still worth checking against
 * Horizon.
 *
 * An envelope past its time bounds can never be included, but one that
 * landed moments before the deadline is still a real, recorded payment —
 * the ledger does not forget it when the intent expires. Once the window is
 * past, the row has nothing left to learn from Horizon and stops costing a
 * request each cycle.
 */
export const STATUS_SYNC_EXPIRED_GRACE_MS = 5 * 60_000;

/** Settlement statuses this job owes a read-only Horizon check. */
const SYNCABLE_SETTLEMENT_STATUSES = ["verifying"] as const;

/** Treasury intent statuses that may still reach the ledger. */
const SYNCABLE_TREASURY_STATUSES = ["pending", "awaiting_signatures"] as const;

/**
 * The result of checking one pending record against Horizon.
 *
 *  `confirmed`   — on-chain success verified, row marked confirmed.
 *  `failed`      — on-chain rejection (or verification mismatch), row marked failed.
 *  `pending`     — Horizon has no record yet; the row is left untouched.
 *  `unavailable` — Horizon could not answer within the retry budget; the row
 *                  is left untouched and retried next cycle.
 *  `skipped`     — the row could not be claimed, or changed underneath us.
 */
export type TxStatusSyncOutcome =
  | "confirmed"
  | "failed"
  | "pending"
  | "unavailable"
  | "skipped";

/** Per-cycle tallies, returned to the caller and logged as the batch summary. */
export interface TxStatusSyncSummary {
  checked: number;
  confirmed: number;
  failed: number;
  pending: number;
  unavailable: number;
  skipped: number;
}

/** Injectable behaviour for tests. */
export interface TxStatusSyncDeps {
  /** Backoff between Horizon retries, so tests never wait on real time. */
  delay?: (ms: number) => Promise<void>;
}

/** The settlement slice this job owes a status sync. */
interface SyncableSettlementRow {
  id: string;
  groupId: string;
  shortCode: string;
  stellarTxHash: string | null;
  retryCount: number;
  amount: unknown;
  assetCode: string;
  assetIssuer: string | null;
  expenseId: string | null;
  status: string;
  updatedAt: Date;
  to: { stellarPublicKey: string } | null;
}

/** The treasury intent slice this job owes a status sync. */
interface SyncableTreasuryRow {
  id: string;
  groupId: string;
  userId: string | null;
  direction: string;
  amount: unknown;
  assetCode: string;
  assetIssuer: string | null;
  destination: string | null;
  stellarTxHash: string | null;
  intendedTxHash: string | null;
  memo: string | null;
}

/** How a failure raised while verifying an already-found transaction reads. */
type VerificationReadError = "transient" | "verification_failed" | "absent";

function emptySummary(): TxStatusSyncSummary {
  return {
    checked: 0,
    confirmed: 0,
    failed: 0,
    pending: 0,
    unavailable: 0,
    skipped: 0,
  };
}

function tally(
  summary: TxStatusSyncSummary,
  outcome: TxStatusSyncOutcome
): void {
  summary[outcome] += 1;
}

function leaseDeadline(now: Date): Date {
  return new Date(now.getTime() + config.WORKER_LEASE_TIMEOUT_MS);
}

/**
 * Take exclusive ownership of a settlement row before checking it.
 *
 * Same conditional-update lease the other settlement jobs use: the row must
 * still be in a syncable status, still carry the hash this worker read, and
 * must not be under a live lease. Two workers racing on one row produce
 * exactly one update with `count === 1`.
 *
 * @param row - The candidate row as read from the database.
 * @param now - The cycle timestamp the lease gates are evaluated against.
 * @returns Whether this worker won the claim.
 */
async function claimSettlementForSync(
  row: { id: string; stellarTxHash: string | null },
  now: Date
): Promise<boolean> {
  const { count } = await prisma.settlement.updateMany({
    where: {
      id: row.id,
      status: { in: [...SYNCABLE_SETTLEMENT_STATUSES] },
      stellarTxHash: row.stellarTxHash,
      AND: [
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    data: {
      claimedBy: SYNC_WORKER_ID,
      claimedAt: now,
      leaseExpiresAt: leaseDeadline(now),
    },
  });

  return count === 1;
}

/** Release this worker's lease, leaving the row's durable state untouched. */
async function releaseSettlementSync(id: string): Promise<void> {
  await prisma.settlement
    .updateMany({
      where: { id, claimedBy: SYNC_WORKER_ID },
      data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
    })
    .catch(() => undefined);
}

/**
 * Read one settlement's recorded hash back from the ledger.
 *
 * Delegates to `reconcileSingleSettlement`, the same read-only verification
 * the pending_confirmation/needs_review job runs — found and successful with
 * a matching memo and payment → `confirmed` (expense share settled in the
 * same transaction), found and failed → `failed`, still silent → `pending`
 * under the shared bounded budget. Nothing here ever submits.
 *
 * @param row - The claimed settlement row, including its destination key.
 * @param ctx - Correlation context for the log lines the reconciliation emits.
 * @param summary - Tally mutated in place with the observed outcome.
 */
async function syncSettlementRow(
  row: SyncableSettlementRow,
  ctx: CorrelationContext,
  summary: TxStatusSyncSummary
): Promise<void> {
  const outcome = await reconcileSingleSettlement(
    {
      id: row.id,
      groupId: row.groupId,
      stellarTxHash: row.stellarTxHash,
      retryCount: row.retryCount,
      shortCode: row.shortCode,
      expenseId: row.expenseId,
      amount: String(row.amount),
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      destinationPublicKey: row.to!.stellarPublicKey,
      status: row.status,
    },
    RECONCILIATION_MAX_RETRIES,
    ctx
  );

  tally(summary, outcome);
  loggerWithContext(log, ctx).info(
    {
      jobType: TX_STATUS_SYNC_JOB,
      jobId: row.id,
      table: "settlements",
      hash: row.stellarTxHash,
      outcome,
    },
    "settlement transaction status synced"
  );
}

/**
 * One cycle over settlements whose confirmation poll was interrupted: load
 * the stale `verifying` rows holding a hash, claim each, delegate the
 * read-only Horizon check, release the lease.
 *
 * A row this worker cannot claim belongs to someone else and is skipped; a
 * row that blows up mid-check is logged and released so the rest of the
 * batch — and the row itself next cycle — keep going.
 */
async function syncStaleVerifyingSettlements(
  now: Date,
  summary: TxStatusSyncSummary
): Promise<void> {
  const cutoff = new Date(now.getTime() - STATUS_SYNC_MIN_AGE_MS);

  let rows: SyncableSettlementRow[];
  try {
    rows = (await prisma.settlement.findMany({
      where: {
        status: { in: [...SYNCABLE_SETTLEMENT_STATUSES] },
        stellarTxHash: { not: null },
        updatedAt: { lt: cutoff },
        AND: [
          { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
        ],
      },
      include: { to: { select: { stellarPublicKey: true } } },
      take: config.WORKER_BATCH_SIZE,
      orderBy: { updatedAt: "asc" as const },
    })) as SyncableSettlementRow[];
  } catch (error) {
    log.warn(
      {
        jobType: TX_STATUS_SYNC_JOB,
        table: "settlements",
        outcome: "query_failed",
        reason: safeFailureMessage(error),
      },
      "unable to load pending settlement transactions"
    );
    return;
  }

  for (const row of rows) {
    // Hashless rows have nothing to check against Horizon, and rows without a
    // destination key cannot be verified — both guards keep the loop safe if
    // the candidate query and this loop ever drift apart.
    if (!row.stellarTxHash || !row.to?.stellarPublicKey) {
      tally(summary, "skipped");
      continue;
    }

    if (!(await claimSettlementForSync(row, now))) {
      tally(summary, "skipped");
      continue;
    }

    const ctx = jobContext(TX_STATUS_SYNC_JOB, row.id);
    summary.checked += 1;

    try {
      await syncSettlementRow(row, ctx, summary);
    } catch (error) {
      // One row blowing up must not take the batch — or the worker — down.
      tally(summary, "unavailable");
      loggerWithContext(log, ctx).warn(
        {
          jobType: TX_STATUS_SYNC_JOB,
          jobId: row.id,
          table: "settlements",
          hash: row.stellarTxHash,
          outcome: "unavailable",
          reason: safeFailureMessage(error),
        },
        "unable to sync settlement transaction status"
      );
    } finally {
      await releaseSettlementSync(row.id);
    }
  }
}

/**
 * Classify a failure raised while reading a transaction that Horizon already
 * reported as present.
 *
 * @param error - The error thrown by the verification reads.
 * @returns `"transient"` when the provider failed (retry next cycle),
 *   `"absent"` when the transaction vanished between reads, or
 *   `"verification_failed"` when the on-chain data does not match the stored
 *   intent — the transaction is real, it just is not ours as recorded.
 */
function classifyVerificationError(error: unknown): VerificationReadError {
  if (error instanceof TimeoutError || error instanceof TransportError) {
    return "transient";
  }
  if (error instanceof AppError) {
    if (error.statusCode === 404) return "absent";
    if (
      error.code === "transaction_verification_failed" ||
      error.code === "settlement_verification_failed"
    ) {
      return "verification_failed";
    }
    // 429 and 5xx mean the provider, not the transaction, failed.
    if (error.statusCode === 429 || error.statusCode >= 500) {
      return "transient";
    }
    // Any other 4xx raised by verification is a mismatch against the intent.
    if (error.statusCode >= 400) return "verification_failed";
  }
  return "transient";
}

/**
 * Prove a found-and-successful transaction is this row's payment before the
 * row is allowed to become confirmed.
 *
 * The memo is checked only when the row recorded one (routes always do); the
 * payment operation binds destination, amount, and asset to the intent.
 *
 * @param row - The treasury row the hash belongs to.
 * @param hash - The on-chain transaction hash being verified.
 * @throws {AppError} `transaction_verification_failed` /
 *   `settlement_verification_failed` when the transaction does not match.
 */
async function verifyTreasuryTransaction(
  row: SyncableTreasuryRow,
  hash: string
): Promise<void> {
  if (row.memo) {
    await verifyTransactionMemo(hash, row.memo);
  }

  const payments = await getTransactionPayments(hash);
  const paymentOp = payments.find((op) => op.type === "payment");
  if (!paymentOp) {
    throw Errors.badRequest(
      "settlement_verification_failed",
      "No payment operation found in treasury transaction"
    );
  }

  if (row.destination) {
    verifyPaymentOperation(paymentOp, {
      destination: row.destination,
      amount: String(row.amount),
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
    });
  }
}

/**
 * Persist an observed on-chain outcome for a treasury intent.
 *
 * The write is compare-and-set: it only lands while the row is still in a
 * syncable status, so a concurrent confirm request (or a second worker) wins
 * exactly once. The audit row records the reason the status moved; the
 * treasury_transactions table itself carries no failure-reason column.
 *
 * @returns Whether this write won — `false` means someone else got there first.
 */
async function markTreasuryTransaction(
  row: SyncableTreasuryRow,
  hash: string,
  status: "confirmed" | "failed",
  reason?: string
): Promise<boolean> {
  const { count } = await prisma.treasuryTransaction.updateMany({
    where: { id: row.id, status: { in: [...SYNCABLE_TREASURY_STATUSES] } },
    data: { status, stellarTxHash: hash },
  });

  if (count === 0) return false;

  await audit({
    userId: row.userId,
    groupId: row.groupId,
    action:
      status === "failed"
        ? AuditAction.TREASURY_TRANSACTION_FAILED
        : AuditAction.TREASURY_TRANSACTION_CONFIRMED,
    entityType: "treasury_transaction",
    entityId: row.id,
    outcome: status === "failed" ? "failure" : "success",
    metadata: {
      worker: "transaction-status-sync",
      stellarTxHash: hash,
      direction: row.direction,
      ...(reason ? { reason } : {}),
    },
  });

  return true;
}

/**
 * Check one treasury intent against Horizon and write back what the ledger
 * says.
 *
 *   found & successful + verification passes  → `confirmed` (hash recorded)
 *   found & successful + verification fails   → `failed`
 *   found & unsuccessful                      → `failed`
 *   not found                                 → `pending`, row untouched
 *   Horizon unreachable after retries         → `unavailable`, row untouched
 *
 * @param row - The pending treasury intent to sync.
 * @param hash - The on-chain hash the row is checked under — its recorded
 *   hash when one exists, otherwise the signature-independent envelope hash.
 * @param deps - Optional injected retry delay for tests.
 * @returns The outcome for this row, for the batch tally.
 */
async function syncTreasuryTransaction(
  row: SyncableTreasuryRow,
  hash: string,
  deps: TxStatusSyncDeps
): Promise<TxStatusSyncOutcome> {
  const ctx = jobContext(TX_STATUS_SYNC_JOB, row.id);
  const rowLog = loggerWithContext(log, ctx);

  const lookup = await withHorizonRetry(() => stellar.getTransaction(hash), {
    policy: HORIZON_RETRY_POLICY,
    ...(deps.delay ? { delay: deps.delay } : {}),
  });

  if (!isRetrySuccess(lookup)) {
    rowLog.warn(
      {
        jobType: TX_STATUS_SYNC_JOB,
        jobId: row.id,
        table: "treasury_transactions",
        hash,
        outcome: "unavailable",
        attempts: lookup.attempts,
        reason: safeFailureMessage(lookup.lastError),
      },
      "Horizon did not answer; treasury transaction status sync deferred to the next cycle"
    );
    return "unavailable";
  }

  const tx = lookup.value;

  if (tx === null) {
    // Horizon has no record of the hash yet — the ordinary state for a
    // signed-but-not-submitted (or just-submitted) intent. Never evidence
    // of payment, and never a reason to change the row.
    rowLog.debug(
      {
        jobType: TX_STATUS_SYNC_JOB,
        jobId: row.id,
        table: "treasury_transactions",
        hash,
        outcome: "pending",
      },
      "treasury transaction not yet visible on Stellar"
    );
    return "pending";
  }

  if (!tx.successful) {
    const reason = `Transaction ${hash} failed on Stellar`;
    if (await markTreasuryTransaction(row, hash, "failed", reason)) {
      rowLog.warn(
        {
          jobType: TX_STATUS_SYNC_JOB,
          jobId: row.id,
          table: "treasury_transactions",
          hash,
          outcome: "failed",
          reason,
        },
        "treasury transaction failed on Stellar"
      );
      return "failed";
    }
    return "skipped";
  }

  try {
    await verifyTreasuryTransaction(row, hash);
  } catch (error) {
    const kind = classifyVerificationError(error);

    if (kind === "absent") {
      rowLog.debug(
        {
          jobType: TX_STATUS_SYNC_JOB,
          jobId: row.id,
          table: "treasury_transactions",
          hash,
          outcome: "pending",
        },
        "treasury transaction disappeared between reads; will re-check next cycle"
      );
      return "pending";
    }

    if (kind === "verification_failed") {
      const reason = safeFailureMessage(error);
      if (await markTreasuryTransaction(row, hash, "failed", reason)) {
        rowLog.warn(
          {
            jobType: TX_STATUS_SYNC_JOB,
            jobId: row.id,
            table: "treasury_transactions",
            hash,
            outcome: "failed",
            reason,
          },
          "treasury transaction does not match the stored intent"
        );
        return "failed";
      }
      return "skipped";
    }

    rowLog.warn(
      {
        jobType: TX_STATUS_SYNC_JOB,
        jobId: row.id,
        table: "treasury_transactions",
        hash,
        outcome: "unavailable",
        reason: safeFailureMessage(error),
      },
      "unable to verify treasury transaction; deferred to the next cycle"
    );
    return "unavailable";
  }

  if (await markTreasuryTransaction(row, hash, "confirmed")) {
    rowLog.info(
      {
        jobType: TX_STATUS_SYNC_JOB,
        jobId: row.id,
        table: "treasury_transactions",
        hash,
        outcome: "confirmed",
      },
      "treasury transaction confirmed on Stellar"
    );
    return "confirmed";
  }

  return "skipped";
}

/**
 * One cycle over live treasury intents: the rows that may already be on the
 * ledger under their envelope hash because someone submitted the signed
 * payment from their own wallet.
 *
 * The candidate query keeps the check window tight — only rows old enough to
 * have been submitted, and only intents that have not been expired for longer
 * than the grace window, since neither a fresh row nor a long-dead envelope
 * can tell this job anything.
 */
async function syncTreasuryTransactions(
  now: Date,
  summary: TxStatusSyncSummary,
  deps: TxStatusSyncDeps
): Promise<void> {
  const cutoff = new Date(now.getTime() - STATUS_SYNC_MIN_AGE_MS);

  let rows: SyncableTreasuryRow[];
  try {
    rows = (await prisma.treasuryTransaction.findMany({
      where: {
        status: { in: [...SYNCABLE_TREASURY_STATUSES] },
        createdAt: { lt: cutoff },
        OR: [
          { expiresAt: null },
          {
            expiresAt: {
              gt: new Date(now.getTime() - STATUS_SYNC_EXPIRED_GRACE_MS),
            },
          },
        ],
        AND: [
          {
            OR: [
              { stellarTxHash: { not: null } },
              { intendedTxHash: { not: null } },
            ],
          },
        ],
      },
      orderBy: { createdAt: "asc" as const },
      take: config.WORKER_BATCH_SIZE,
    })) as SyncableTreasuryRow[];
  } catch (error) {
    log.warn(
      {
        jobType: TX_STATUS_SYNC_JOB,
        table: "treasury_transactions",
        outcome: "query_failed",
        reason: safeFailureMessage(error),
      },
      "unable to load pending treasury transactions"
    );
    return;
  }

  for (const row of rows) {
    const hash = row.stellarTxHash ?? row.intendedTxHash;
    // A row with neither hash has never been bound to an envelope — there is
    // nothing on the ledger to ask about.
    if (!hash) {
      tally(summary, "skipped");
      continue;
    }
    summary.checked += 1;

    let outcome: TxStatusSyncOutcome;
    try {
      outcome = await syncTreasuryTransaction(row, hash, deps);
    } catch (error) {
      // One row blowing up must not take the batch — or the worker — down.
      outcome = "unavailable";
      log.warn(
        {
          jobType: TX_STATUS_SYNC_JOB,
          jobId: row.id,
          table: "treasury_transactions",
          hash,
          outcome: "unavailable",
          reason: safeFailureMessage(error),
        },
        "unexpected error syncing treasury transaction status"
      );
    }

    tally(summary, outcome);
  }
}

/**
 * Sync every pending Stellar transaction the database still owes an answer
 * for, and report what the cycle observed.
 *
 * Safe to run every worker cycle: candidate queries are bounded by
 * config.WORKER_BATCH_SIZE, claims are lease-guarded, writes are
 * compare-and-set, and a Horizon that never answers defers rows to the next
 * cycle instead of failing them.
 *
 * @param now - The cycle timestamp; injectable so tests can pin cutoffs.
 * @param deps - Optional injected retry delay for tests.
 * @returns Per-outcome tallies for the cycle.
 */
export async function syncPendingTransactionStatuses(
  now: Date = new Date(),
  deps: TxStatusSyncDeps = {}
): Promise<TxStatusSyncSummary> {
  const summary = emptySummary();

  await syncStaleVerifyingSettlements(now, summary);
  await syncTreasuryTransactions(now, summary, deps);

  log.info(
    {
      jobType: TX_STATUS_SYNC_JOB,
      outcome: "batch_synced",
      checked: summary.checked,
      confirmed: summary.confirmed,
      failed: summary.failed,
      pending: summary.pending,
      unavailable: summary.unavailable,
      skipped: summary.skipped,
    },
    "pending Stellar transaction statuses synced"
  );

  return summary;
}
