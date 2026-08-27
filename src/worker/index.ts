/**
 * Background worker.
 *
 * Two job families run here — settlement submission and SEP-24 anchor
 * reconciliation — and both follow the same rules:
 *
 *  **Claim before work.** A job is claimed with a conditional update that also
 *  writes a lease (`claimedBy`, `leaseExpiresAt`). Only one worker can win that
 *  update, so two processes can never drive the same settlement transition. A
 *  worker that crashes leaves its lease behind; the lease lapses and the job
 *  becomes eligible again, which is what makes a restart resume work without
 *  duplicating it.
 *
 *  **Classify before retrying.** Every failure is categorised (see
 *  src/services/job-retry.ts). Transient failures get bounded, jittered
 *  exponential backoff. Indeterminate failures — a timeout, a dropped socket —
 *  are never blindly resubmitted: the envelope's hash is deterministic, so the
 *  worker asks Horizon whether the transaction already applied first. Permanent
 *  failures (rejected transaction, expired intent, authorization, validation)
 *  stop immediately and stay visible with a recorded reason.
 *
 *  **Persist the job state.** Attempts, the next eligible time, the failure
 *  category, and the final reason are all columns, not process memory, so the
 *  next cycle — or the next process — picks up exactly where this one stopped.
 *
 *  **Log operationally, never sensitively.** Every line carries a correlation
 *  id, job type, job id, attempt, and outcome. Signed XDRs, tokens, and secrets
 *  are scrubbed by `safeFailureMessage` and never logged or persisted.
 *
 * Settlement state transitions themselves stay authoritative in
 * src/services/settlement-machine.ts, which writes each change with its audit
 * record in one transaction.
 */
import { randomUUID } from "node:crypto";
import pino from "pino";
import { config } from "../config";
import { prisma } from "../db";
import { isIntentExpired } from "../lib/time-bounds";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import {
  applySettlementTransition,
  type SettlementStatus,
} from "../services/settlement-machine";
import { pollForConfirmation } from "../services/horizon-confirm";
import { settlementPaymentIntent } from "../services/settlement-xdr";
import {
  anchorService,
  AUDITABLE_ANCHOR_STATUSES,
  TERMINAL_ANCHOR_STATUSES,
  type PollResult,
} from "../services/anchor";
import { applyAnchorSessionTransition } from "../services/anchor-status";
import { recordStatusTransition } from "../services/status-history";
import {
  ANCHOR_RETRY_POLICY,
  classifyJobFailure,
  retryDelayMs,
  safeFailureMessage,
  SETTLEMENT_RETRY_POLICY,
  type JobFailureCategory,
} from "../services/job-retry";
import { reconcileSettlements } from "../services/settlement-reconciliation";
import { startReconciliation } from "./reconciliation";
import { cleanupChallenges } from "./tasks/cleanup-challenges";
import {
  type CorrelationContext,
  jobContext,
  loggerWithContext,
} from "../lib/correlation";

const log = pino({ name: "worker" });

/** Identifies this process in job leases, so it can release its own claims. */
const WORKER_ID = randomUUID();

/** Total submission attempts per settlement, including the first. */
export const SETTLEMENT_MAX_RETRIES = SETTLEMENT_RETRY_POLICY.maxAttempts;

let isShuttingDown = false;

/**
 * Sleep between in-cycle retries. Injectable so tests can drive the backoff
 * schedule without real time passing.
 */
let delayFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setDelayFn(fn: (ms: number) => Promise<void>): void {
  delayFn = fn;
}

/** Statuses a settlement can be in while the worker still owes it a submission. */
const SUBMITTABLE_STATUSES = ["submitted", "verifying"] as const;

interface SettlementJob {
  id: string;
  shortCode: string;
  groupId: string;
  fromPublicKey: string;
  toPublicKey: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  transactionXdr: string | null;
  expenseShareId: string | null;
  expiresAt: Date | null;
  retryCount: number;
  status: string;
}

// ---------------------------------------------------------------------------
// settlement submission
// ---------------------------------------------------------------------------

function leaseDeadline(): Date {
  return new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS);
}

/**
 * Take exclusive ownership of a settlement job.
 *
 * The guard is what enforces single processing: the row must still be in a
 * submittable status, still be on the attempt this worker read, and must not
 * carry a live lease. Two workers racing on the same row produce exactly one
 * update with `count === 1`.
 */
async function claimSettlement(job: SettlementJob): Promise<boolean> {
  if (isShuttingDown) return false;
  const now = new Date();

  const { count } = await prisma.settlement.updateMany({
    where: {
      id: job.id,
      status: { in: [...SUBMITTABLE_STATUSES] },
      retryCount: job.retryCount,
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    data: {
      claimedBy: WORKER_ID,
      claimedAt: now,
      leaseExpiresAt: leaseDeadline(),
    },
  });

  return count === 1;
}

/** Release this worker's lease, leaving the job's durable state untouched. */
async function releaseSettlement(id: string): Promise<void> {
  await prisma.settlement
    .updateMany({
      where: { id, claimedBy: WORKER_ID },
      data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
    })
    .catch(() => undefined);
}

/** Record an attempt as started, and renew the lease while it runs. */
async function recordAttemptStarted(job: SettlementJob, attempt: number): Promise<void> {
  await prisma.settlement.update({
    where: { id: job.id },
    data: {
      retryCount: attempt,
      nextAttemptAt: null,
      leaseExpiresAt: leaseDeadline(),
    },
  });
}

/** Persist the backoff schedule so the next cycle — or process — resumes it. */
async function scheduleRetry(params: {
  job: SettlementJob;
  attempt: number;
  category: JobFailureCategory;
  reason: string;
  delayMs: number;
  ctx: CorrelationContext;
}): Promise<void> {
  const { job, attempt, category, reason, delayMs, ctx } = params;
  const nextAttemptAt = new Date(Date.now() + delayMs);

  await prisma.settlement.update({
    where: { id: job.id },
    data: {
      retryCount: attempt,
      nextAttemptAt,
      errorCategory: category,
      failureReason: reason,
      leaseExpiresAt: leaseDeadline(),
    },
  });

  await recordStatusTransition({
    entityType: "settlement",
    entityId: job.id,
    newStatus: job.status,
    reason,
    source: "worker",
  }).catch(() => undefined);

  loggerWithContext(log, ctx).warn(
    {
      jobType: "settlement",
      jobId: job.id,
      attempt,
      maxAttempts: SETTLEMENT_RETRY_POLICY.maxAttempts,
      outcome: "retry_scheduled",
      category,
      nextAttemptAt: nextAttemptAt.toISOString(),
      nextDelayMs: delayMs,
      reason,
    },
    "settlement submission retry scheduled"
  );
}

/** Stop retrying and leave the job visible to operators with a reason. */
async function failSettlement(params: {
  job: SettlementJob;
  attempt: number;
  category: JobFailureCategory;
  reason: string;
  ctx: CorrelationContext;
}): Promise<void> {
  const { job, attempt, category, reason, ctx } = params;

  await applySettlementTransition({
    settlementId: job.id,
    nextStatus: "failed",
    source: "worker",
    extraData: {
      failureReason: reason,
      errorCategory: category,
      retryCount: attempt,
      nextAttemptAt: null,
    },
  });

  await recordStatusTransition({
    entityType: "settlement",
    entityId: job.id,
    newStatus: "failed",
    reason,
    source: "worker",
  }).catch(() => undefined);

  loggerWithContext(log, ctx).error(
    {
      jobType: "settlement",
      jobId: job.id,
      attempt,
      outcome: "failed",
      category,
      reason,
    },
    "settlement failed"
  );
}

/** Move a settlement to a non-failure status, tolerating a disallowed hop. */
async function transitionSettlement(
  job: SettlementJob,
  nextStatus: SettlementStatus,
  extraData?: Record<string, unknown>,
  settleExpenseShare = false
): Promise<void> {
  await applySettlementTransition({
    settlementId: job.id,
    nextStatus,
    source: "worker",
    extraData: extraData as never,
    settleExpenseShare,
  });
}

/**
 * Ask Horizon whether the envelope already applied.
 *
 * The hash is derived from the signed envelope, so it is known without another
 * submission — this is what makes an indeterminate failure recoverable rather
 * than a coin flip between a stuck payment and a double payment.
 */
async function alreadyApplied(
  job: SettlementJob
): Promise<{ hash: string; successful: boolean } | null> {
  if (!job.transactionXdr) return null;
  try {
    const hash = stellar.hashOf(job.transactionXdr);
    const found = await stellar.getTransaction(hash);
    if (!found) return null;
    return { hash, successful: found.successful };
  } catch {
    // Horizon being unreachable tells us nothing; the caller keeps retrying.
    return null;
  }
}

/** Record a successful submission and verify it reached the ledger. */
async function confirmSubmission(params: {
  job: SettlementJob;
  hash: string;
  attempt: number;
  ctx: CorrelationContext;
}): Promise<void> {
  const { job, hash, attempt, ctx } = params;
  const jobLog = loggerWithContext(log, ctx);

  await transitionSettlement(job, "verifying", {
    stellarTxHash: hash,
    errorCategory: null,
    failureReason: null,
    nextAttemptAt: null,
  });

  await audit({
    userId: null,
    groupId: job.groupId,
    action: "settlement.submitted_to_stellar",
    entityType: "settlement",
    entityId: job.id,
    outcome: "success",
    metadata: { stellarTxHash: hash, attempt },
  });

  jobLog.info(
    { jobType: "settlement", jobId: job.id, attempt, outcome: "submitted", hash },
    "settlement submitted to Stellar"
  );

  const confirmation = await pollForConfirmation(hash);

  if (confirmation.status === "confirmed") {
    await transitionSettlement(
      job,
      "confirmed",
      {
        stellarTxHash: hash,
        retryCount: 0,
        errorCategory: null,
        failureReason: null,
        nextAttemptAt: null,
      },
      true
    );
    jobLog.info(
      { jobType: "settlement", jobId: job.id, attempt, outcome: "confirmed", hash },
      "settlement confirmed on Stellar"
    );
    return;
  }

  if (confirmation.status === "failed") {
    await failSettlement({
      job,
      attempt,
      category: "permanent",
      reason: `Transaction ${hash} failed on Stellar`,
      ctx,
    });
    return;
  }

  // Submitted but not yet visible, or Horizon stopped answering. Neither is
  // evidence of payment and neither is a reason to submit again — hand it to a
  // human-visible state and let reconciliation keep watching the hash.
  await transitionSettlement(job, "needs_review", {
    stellarTxHash: hash,
    errorCategory: "indeterminate",
    failureReason: `Awaiting on-chain confirmation for ${hash}`,
    nextAttemptAt: null,
  });
  jobLog.warn(
    {
      jobType: "settlement",
      jobId: job.id,
      attempt,
      outcome: "needs_review",
      hash,
      confirmation: confirmation.status,
    },
    "settlement submitted but not confirmed on Stellar"
  );
}

/**
 * Run one settlement job to a durable conclusion: submitted and verified,
 * scheduled for another attempt, or failed with a recorded reason.
 */
export async function processSettlementJob(
  job: SettlementJob,
  ctx: CorrelationContext
): Promise<void> {
  const jobLog = loggerWithContext(log, ctx);

  if (!job.transactionXdr) {
    await failSettlement({
      job,
      attempt: job.retryCount,
      category: "permanent",
      reason: "Settlement has no signed transaction to submit",
      ctx,
    });
    return;
  }

  // An expired intent must never reach Horizon: the envelope's own maxTime has
  // passed, so submitting it can only produce tx_too_late.
  if (isIntentExpired(job.expiresAt)) {
    await failSettlement({
      job,
      attempt: job.retryCount,
      category: "permanent",
      reason: "Signing window expired before the transaction was submitted",
      ctx,
    });
    return;
  }

  if (job.status === "submitted") {
    await transitionSettlement(job, "verifying");
    job.status = "verifying";
  }

  const policy = SETTLEMENT_RETRY_POLICY;
  let attempt = job.retryCount;

  while (attempt < policy.maxAttempts) {
    attempt += 1;
    await recordAttemptStarted(job, attempt);

    try {
      // The stored envelope is re-validated against this settlement's own
      // recorded intent before anything reaches Horizon — the API's intent,
      // not whatever was persisted alongside it.
      const hash = await stellar.submitPayment(
        job.transactionXdr,
        settlementPaymentIntent({
          shortCode: job.shortCode,
          amount: job.amount,
          assetCode: job.assetCode,
          assetIssuer: job.assetIssuer,
          expiresAt: job.expiresAt,
          from: { stellarPublicKey: job.fromPublicKey },
          to: { stellarPublicKey: job.toPublicKey },
        })
      );

      await confirmSubmission({ job, hash, attempt, ctx });
      return;
    } catch (error) {
      const reason = safeFailureMessage(error);
      let category = classifyJobFailure(error);

      if (category === "indeterminate") {
        // The call may have taken effect. Check the ledger before deciding.
        const applied = await alreadyApplied(job);
if (applied?.successful) {
        jobLog.warn(
          {
            jobType: "settlement",
            jobId: job.id,
            attempt,
            outcome: "already_applied",
            hash: applied.hash,
          },
          "submission response was lost but the transaction had applied"
        );
        await transitionSettlement(
          job,
          "confirmed",
          {
            stellarTxHash: applied.hash,
            retryCount: 0,
            errorCategory: null,
            failureReason: null,
            nextAttemptAt: null,
          },
          true
        );
        return;
      }
        if (applied && !applied.successful) {
          await failSettlement({
            job,
            attempt,
            category: "permanent",
            reason: `Transaction ${applied.hash} failed on Stellar`,
            ctx,
          });
          return;
        }
        // Horizon has no record of it: nothing applied, so retry as transient.
        category = "transient";
      }

      if (category === "permanent") {
        await failSettlement({ job, attempt, category, reason, ctx });
        return;
      }

      if (attempt >= policy.maxAttempts) {
        // Bounded: an exhausted job stops retrying and becomes an operator's
        // problem rather than an unbounded loop against a failing provider.
        await failSettlement({
          job,
          attempt,
          category: "permanent",
          reason: `${reason} (retries exhausted after ${attempt} attempts)`,
          ctx,
        });
        return;
      }

      const delayMs = retryDelayMs(attempt, policy);
      await scheduleRetry({ job, attempt, category, reason, delayMs, ctx });
      await delayFn(delayMs);
    }
  }
}

/** Map a settlement row to the job shape the processor works with. */
function toSettlementJob(row: {
  id: string;
  shortCode: string;
  groupId: string;
  amount: unknown;
  assetCode: string;
  assetIssuer: string | null;
  transactionXdr: string | null;
  expenseShareId: string | null;
  expiresAt?: Date | null;
  retryCount: number;
  status: string;
  from: { stellarPublicKey: string };
  to: { stellarPublicKey: string };
}): SettlementJob {
  return {
    id: row.id,
    shortCode: row.shortCode,
    groupId: row.groupId,
    fromPublicKey: row.from.stellarPublicKey,
    toPublicKey: row.to.stellarPublicKey,
    amount: String(row.amount),
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    transactionXdr: row.transactionXdr,
    expenseShareId: row.expenseShareId,
    expiresAt: row.expiresAt ?? null,
    retryCount: row.retryCount,
    status: row.status,
  };
}

/**
 * One cycle of settlement submission: pick up every eligible job, claim it,
 * and run it. Rows still inside their backoff window, or held by another
 * worker's live lease, are skipped.
 */
export async function processSubmittedSettlements(): Promise<void> {
  const now = new Date();

  const rows = await prisma.settlement.findMany({
    where: {
      status: { in: [...SUBMITTABLE_STATUSES] },
      transactionXdr: { not: null },
      retryCount: { lt: SETTLEMENT_RETRY_POLICY.maxAttempts },
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    include: {
      from: { select: { stellarPublicKey: true } },
      to: { select: { stellarPublicKey: true } },
    },
    take: config.WORKER_BATCH_SIZE,
    orderBy: [{ nextAttemptAt: "asc" as const }, { createdAt: "asc" as const }],
  });

  for (const row of rows) {
    if (isShuttingDown) return;

    const job = toSettlementJob(row as never);
    const ctx = jobContext("settlement", job.id);

    if (!(await claimSettlement(job))) continue;

    try {
      await processSettlementJob(job, ctx);
    } catch (error) {
      // A job blowing up must not take the batch — or the worker — down.
      loggerWithContext(log, ctx).error(
        {
          jobType: "settlement",
          jobId: job.id,
          attempt: job.retryCount,
          outcome: "error",
          reason: safeFailureMessage(error),
        },
        "unexpected error processing settlement"
      );
    } finally {
      await releaseSettlement(job.id);
    }
  }
}

/**
 * Free leases left behind by processes that died mid-job.
 *
 * Called at the top of every cycle, so a restarted worker recovers its
 * predecessor's work rather than waiting for a lease to be released by a
 * process that no longer exists.
 */
export async function recoverStaleSettlements(): Promise<number> {
  const now = new Date();
  const { count } = await prisma.settlement.updateMany({
    where: {
      status: { in: [...SUBMITTABLE_STATUSES] },
      leaseExpiresAt: { lt: now },
    },
    data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
  });

  if (count > 0) {
    log.info(
      { jobType: "settlement", outcome: "lease_recovered", count },
      "recovered settlement jobs from expired leases"
    );
  }
  return count;
}

// ---------------------------------------------------------------------------
// anchor reconciliation
// ---------------------------------------------------------------------------

interface AnchorJob {
  id: string;
  externalTransactionId: string | null;
  anchorToken: string | null;
  status: string;
  retryCount: number;
}

async function claimAnchorSession(job: AnchorJob): Promise<boolean> {
  if (isShuttingDown) return false;
  const now = new Date();

  const { count } = await prisma.anchorSession.updateMany({
    where: {
      id: job.id,
      retryCount: job.retryCount,
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    data: {
      claimedBy: WORKER_ID,
      claimedAt: now,
      leaseExpiresAt: leaseDeadline(),
    },
  });

  return count === 1;
}

async function releaseAnchorSession(id: string): Promise<void> {
  await prisma.anchorSession
    .updateMany({
      where: { id, claimedBy: WORKER_ID },
      data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
    })
    .catch(() => undefined);
}

/** Poll one anchor session and advance (or reschedule) it. */
async function reconcileSingleAnchor(
  job: AnchorJob,
  transferServer: string,
  ctx: CorrelationContext
): Promise<void> {
  const jobLog = loggerWithContext(log, ctx);

  if (!job.anchorToken || !job.externalTransactionId) {
    jobLog.warn(
      { jobType: "anchor", jobId: job.id, outcome: "skipped" },
      "anchor session is missing its token or external transaction id"
    );
    return;
  }

  const attempt = job.retryCount + 1;
  const result: PollResult = await anchorService.pollTransaction({
    transferServer,
    token: job.anchorToken,
    id: job.externalTransactionId,
  });

  const now = new Date();

  // ── poll failed (timeout, network, malformed response) ───────────────────
  if (result.isError) {
    const exhausted = attempt >= ANCHOR_RETRY_POLICY.maxAttempts;
    const reason = safeFailureMessage(result.message);

    await prisma.anchorSession.update({
      where: { id: job.id },
      data: {
        lastPolledAt: now,
        retryCount: attempt,
        failureReason: reason,
        errorCategory: exhausted ? "permanent" : "transient",
        nextAttemptAt: exhausted
          ? null
          : new Date(Date.now() + retryDelayMs(attempt, ANCHOR_RETRY_POLICY)),
      },
    });

    jobLog.warn(
      {
        jobType: "anchor",
        jobId: job.id,
        attempt,
        outcome: exhausted ? "retries_exhausted" : "retry_scheduled",
        reason,
      },
      "anchor poll failed"
    );
    return;
  }

  // ── status unchanged ─────────────────────────────────────────────────────
  if (result.status === job.status) {
    await prisma.anchorSession.update({
      where: { id: job.id },
      data: {
        lastPolledAt: now,
        failureReason: null,
        errorCategory: null,
        nextAttemptAt: null,
        retryCount: 0,
      },
    });
    return;
  }

  // ── terminal-state protection ────────────────────────────────────────────
  // Anchor responses are untrusted and can arrive out of order; a local
  // terminal state is never walked back.
  if (TERMINAL_ANCHOR_STATUSES.has(job.status)) {
    jobLog.warn(
      {
        jobType: "anchor",
        jobId: job.id,
        attempt,
        outcome: "ignored",
        localStatus: job.status,
        remoteStatus: result.status,
      },
      "anchor reported a different status for a terminal session"
    );
    return;
  }

  // ── advance ──────────────────────────────────────────────────────────────
  await applyAnchorSessionTransition({
    sessionId: job.id,
    nextStatus: result.status,
    source: "poll",
    extraData: {
      lastPolledAt: now,
      failureReason: result.status === "error" ? result.message ?? null : null,
      errorCategory: null,
      nextAttemptAt: null,
      retryCount: 0,
    } as never,
  });

  await recordStatusTransition({
    entityType: "anchor_session",
    entityId: job.id,
    newStatus: result.status,
    reason: result.status === "error" ? result.message ?? undefined : undefined,
    source: "worker",
  }).catch(() => undefined);

  jobLog.info(
    {
      jobType: "anchor",
      jobId: job.id,
      attempt,
      outcome: "advanced",
      fromStatus: job.status,
      toStatus: result.status,
    },
    "anchor session status advanced"
  );

  if (AUDITABLE_ANCHOR_STATUSES.has(result.status)) {
    await audit({
      action: `anchor.session.${result.status}`,
      entityType: "anchor_session",
      entityId: job.id,
      outcome: result.status === "error" ? "failure" : "success",
      metadata: {
        previousStatus: job.status,
        status: result.status,
        rawStatus: result.rawStatus,
        amountIn: result.amountIn,
        amountOut: result.amountOut,
        amountFee: result.amountFee,
        stellarTransactionHash: result.stellarTransactionHash,
      },
    });
  }
}

/** One cycle of SEP-24 anchor reconciliation. */
export async function reconcileAnchors(): Promise<void> {
  const now = new Date();

  const sessions = await prisma.anchorSession.findMany({
    where: {
      status: { in: ["incomplete", "pending_user_transfer_start", "pending_anchor"] },
      externalTransactionId: { not: null },
      AND: [
        { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
        { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
      ],
    },
    take: config.WORKER_BATCH_SIZE,
    orderBy: { lastPolledAt: "asc" as const },
  });

  if (sessions.length === 0) return;

  let transferServer: string;
  try {
    const toml = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
    transferServer = toml.transferServerSep24;
  } catch (error) {
    // The anchor is unreachable entirely — skip the cycle rather than burning
    // every session's retry budget on the same outage.
    log.warn(
      { jobType: "anchor", outcome: "skipped_cycle", reason: safeFailureMessage(error) },
      "anchor TOML unavailable"
    );
    return;
  }

  for (const session of sessions) {
    if (isShuttingDown) return;

    const job: AnchorJob = {
      id: session.id,
      externalTransactionId: session.externalTransactionId,
      anchorToken: session.anchorToken,
      status: session.status,
      retryCount: session.retryCount,
    };
    const ctx = jobContext("anchor", job.id);

    if (!(await claimAnchorSession(job))) continue;

    try {
      await reconcileSingleAnchor(job, transferServer, ctx);
    } catch (error) {
      loggerWithContext(log, ctx).error(
        {
          jobType: "anchor",
          jobId: job.id,
          attempt: job.retryCount + 1,
          outcome: "error",
          reason: safeFailureMessage(error),
        },
        "unexpected error reconciling anchor session"
      );
    } finally {
      await releaseAnchorSession(job.id);
    }
  }
}

/** Free anchor leases left behind by a crashed process. */
export async function recoverStaleAnchorSessions(): Promise<number> {
  const { count } = await prisma.anchorSession.updateMany({
    where: { leaseExpiresAt: { lt: new Date() } },
    data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
  });

  if (count > 0) {
    log.info(
      { jobType: "anchor", outcome: "lease_recovered", count },
      "recovered anchor jobs from expired leases"
    );
  }
  return count;
}

// ---------------------------------------------------------------------------
// housekeeping + loop
// ---------------------------------------------------------------------------

export async function expireInvites(): Promise<void> {
  await prisma.invite.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
}

export async function runWorkerCycle(): Promise<void> {
  // Recover first: a restart should adopt the previous process's work before
  // looking for new jobs.
  await Promise.allSettled([recoverStaleSettlements(), recoverStaleAnchorSessions()]);

  await Promise.allSettled([
    processSubmittedSettlements(),
    reconcileAnchors(),
    reconcileSettlements(),
    expireInvites(),
    cleanupChallenges(),
  ]);
}

export async function startWorker(): Promise<() => Promise<void>> {
  const stopReconciliation = startReconciliation();
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runWorkerCycle();
    } catch (error) {
      log.error({ outcome: "error", reason: safeFailureMessage(error) }, "worker cycle failed");
    }
    if (!stopped) timer = setTimeout(() => void loop(), config.WORKER_INTERVAL_MS);
  };

  void loop();

  const shutdown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    isShuttingDown = true;
    if (timer) clearTimeout(timer);
    stopReconciliation();

    log.info({ outcome: "shutdown" }, "worker shutting down, releasing claims");

    // Release every lease this process holds so the next worker can pick the
    // jobs up immediately instead of waiting for them to lapse.
    await Promise.allSettled([
      prisma.settlement.updateMany({
        where: { claimedBy: WORKER_ID },
        data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
      }),
      prisma.anchorSession.updateMany({
        where: { claimedBy: WORKER_ID },
        data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
      }),
    ]);

    log.info({ outcome: "shutdown_complete" }, "worker claims released");
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  return shutdown;
}

if (process.env.NODE_ENV !== "test") {
  // Config validation already ran at module load; this catches a worker started
  // against an environment missing the external endpoints it depends on.
  if (!config.DATABASE_URL || !config.HORIZON_URL || !config.ANCHOR_HOME_DOMAIN) {
    console.error("❌ Critical configuration missing for worker. Exiting.");
    process.exit(1);
  }
  void startWorker();
}
