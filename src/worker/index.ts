import pino from "pino";
import { randomUUID } from "node:crypto";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import {
  applySettlementTransition,
  classifySettlementError,
} from "../services/settlement-machine";
import { pollForConfirmation } from "../services/horizon-confirm";
import { retryDelayMs, SETTLEMENT_RETRY_POLICY } from "../services/job-retry";
import {
  anchorService,
  TERMINAL_ANCHOR_STATUSES,
  AUDITABLE_ANCHOR_STATUSES,
} from "../services/anchor";
import type { PollResult } from "../services/anchor";
import { runReconciliation, startReconciliation } from "./reconciliation";
import { reconcileSettlements } from "../services/settlement-reconciliation";
import {
  type CorrelationContext,
  jobContext,
  loggerWithContext,
} from "../lib/correlation";

interface SettlementSubmissionRecord {
  id: string;
  shortCode: string;
  fromPublicKey: string;
  toPublicKey: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  transactionXdr: string | null;
  retryCount: number;
  status: string;
  createdAt: Date;
}

const log = pino({ name: "worker" });

export const SETTLEMENT_MAX_RETRIES = SETTLEMENT_RETRY_POLICY.maxAttempts;

const WORKER_ID = randomUUID();
const claimedSettlements = new Set<string>();
const claimedAnchors = new Set<string>();

class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSettlementError";
  }
}

/**
 * The delay used between settlement retry attempts. Overridable so tests can
 * replace real timers with an instrumented no-op instead of relying on fake
 * timers alone.
 */
let delayFn: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function setDelayFn(fn: (ms: number) => Promise<void>): void {
  delayFn = fn;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bearer\s+[a-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/(?:secret|token|password|private[_ -]?key)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(?:xdr|transaction)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Settlement submission
// ---------------------------------------------------------------------------
//
// A settlement's signed XDR is submitted to Stellar, then verified against
// Horizon before being considered confirmed — a successful submitPayment()
// call only means Horizon accepted the envelope, not that we're certain of
// the outcome if our own connection drops before the response arrives. The
// status machine (src/services/settlement-machine.ts) enforces this as
// submitted -> verifying -> confirmed | failed | needs_review.

function claimSettlement(id: string): boolean {
  if (claimedSettlements.has(id)) return false;
  claimedSettlements.add(id);
  return true;
}

function releaseSettlementClaim(id: string): void {
  claimedSettlements.delete(id);
}

export async function submitSettlement(
  settlement: SettlementSubmissionRecord,
  retryAttempt: number,
  ctx?: CorrelationContext
): Promise<string> {
  if (!settlement.transactionXdr) {
    throw new PermanentSettlementError("settlement has no transaction XDR");
  }

  const jobLog = loggerWithContext(log, ctx);

  try {
    // Re-validate the signed XDR against the settlement's own recorded
    // intent immediately before submission — this is the only place the
    // stored signedXdr is checked against what the server actually
    // authorized (source, destination, asset, amount, memo), since
    // POST /settlements/:id/confirm persists it without validating it.
    const hash = await stellar.submitPayment(settlement.transactionXdr, {
      sourcePublicKey: settlement.fromPublicKey,
      destination: settlement.toPublicKey,
      asset: { code: settlement.assetCode, issuer: settlement.assetIssuer },
      amount: settlement.amount,
      memoCode: settlement.shortCode,
    });
    jobLog.info({ id: settlement.id, hash }, "settlement submitted successfully");
    return hash;
  } catch (error) {
    const classification = classifySettlementError(error);
    if (classification === "permanent" || retryAttempt >= SETTLEMENT_MAX_RETRIES) {
      throw new PermanentSettlementError(safeErrorMessage(error));
    }
    throw error;
  }
}

async function markSettlementFailed(
  settlementId: string,
  message: string,
  errorCategory: "transient" | "permanent",
  ctx?: CorrelationContext
): Promise<void> {
  await applySettlementTransition({
    settlementId,
    nextStatus: "failed",
    source: "worker",
    extraData: {
      failureReason: message,
      errorCategory,
      nextAttemptAt: null,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });
  loggerWithContext(log, ctx).error(
    { id: settlementId, reason: message },
    "settlement failed"
  );
}

async function verifySettlementOutcome(
  settlementId: string,
  hash: string,
  attempt: number,
  ctx: CorrelationContext | undefined,
  jobLog: ReturnType<typeof loggerWithContext>
): Promise<void> {
  const confirmation = await pollForConfirmation(hash);

  if (confirmation.status === "confirmed") {
    await applySettlementTransition({
      settlementId,
      nextStatus: "confirmed",
      source: "worker",
      extraData: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
    });
    jobLog.info({ id: settlementId, hash, attempt }, "settlement confirmed on Stellar");
    return;
  }

  if (confirmation.status === "failed") {
    await markSettlementFailed(
      settlementId,
      `Transaction ${hash} was rejected by the Stellar network`,
      "permanent",
      ctx
    );
    return;
  }

  // not_found / timeout: Horizon never showed the transaction within the
  // configured polling window. This is genuinely ambiguous — it may not have
  // reached consensus, or it may be visible moments from now — so it is
  // parked for manual/automated re-verification rather than guessed at.
  await applySettlementTransition({
    settlementId,
    nextStatus: "needs_review",
    source: "worker",
    extraData: {
      failureReason: `Could not confirm transaction ${hash} on Horizon`,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });
  jobLog.warn({ id: settlementId, hash, attempt }, "settlement needs manual review");
}

async function processSettlement(
  settlement: SettlementSubmissionRecord,
  ctx?: CorrelationContext
): Promise<void> {
  if (!claimSettlement(settlement.id)) return;
  const jobLog = loggerWithContext(log, ctx);

  try {
    const initialAttempt = Math.max(1, settlement.retryCount);
    const remainingAttempts = Math.max(1, SETTLEMENT_MAX_RETRIES - initialAttempt + 1);

    for (let offset = 0; offset < remainingAttempts; offset += 1) {
      const attempt = initialAttempt + offset;
      try {
        const hash = await submitSettlement(settlement, attempt, ctx);
        // A settlement recovered from "verifying" on worker restart is
        // already past "submitted"; applySettlementTransition treats the
        // same-status case as a no-op write (still persists extraData).
        await applySettlementTransition({
          settlementId: settlement.id,
          nextStatus: "verifying",
          source: "worker",
          extraData: { stellarTxHash: hash, retryCount: 0 },
        });
        await verifySettlementOutcome(settlement.id, hash, attempt, ctx, jobLog);
        return;
      } catch (error) {
        const message = safeErrorMessage(error);
        const permanent =
          error instanceof PermanentSettlementError ||
          classifySettlementError(error) === "permanent" ||
          attempt >= SETTLEMENT_MAX_RETRIES;

        if (permanent) {
          await markSettlementFailed(settlement.id, message, "permanent", ctx);
          return;
        }

        const delay = retryDelayMs(attempt);
        const nextAttemptAt = new Date(Date.now() + delay);
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            retryCount: attempt,
            nextAttemptAt,
            errorCategory: "transient",
            leaseExpiresAt: new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS),
          },
        });
        jobLog.warn(
          { id: settlement.id, attempt, nextRetryDelayMs: delay, reason: message },
          "settlement retry scheduled"
        );
        await delayFn(delay);
      }
    }
  } finally {
    releaseSettlementClaim(settlement.id);
  }
}

export async function processSubmittedSettlements(): Promise<void> {
  const now = new Date();
  const settlements = await prisma.settlement.findMany({
    where: {
      status: { in: ["submitted", "verifying"] },
      transactionXdr: { not: null },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    include: {
      from: { select: { stellarPublicKey: true } },
      to: { select: { stellarPublicKey: true } },
    },
    take: 50,
    orderBy: [{ nextAttemptAt: "asc" as const }, { createdAt: "asc" as const }],
  });

  for (const row of settlements) {
    const settlement: SettlementSubmissionRecord = {
      id: row.id,
      shortCode: row.shortCode,
      fromPublicKey: row.from.stellarPublicKey,
      toPublicKey: row.to.stellarPublicKey,
      amount: row.amount.toString(),
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      transactionXdr: row.transactionXdr,
      retryCount: row.retryCount,
      status: row.status,
      createdAt: row.createdAt,
    };
    const ctx = jobContext("settlement", row.id);
    await processSettlement(settlement, ctx);
  }
}

// ---------------------------------------------------------------------------
// SEP-24 anchor session reconciliation
// ---------------------------------------------------------------------------

/** Maximum number of failed poll attempts before marking a session as error. */
const ANCHOR_MAX_RETRIES = 3;
const ANCHOR_POLL_BATCH_SIZE = 50;

/**
 * Minimum interval between polls for the same session (seconds).
 * Sessions polled more recently than this are skipped.
 */
const ANCHOR_MIN_POLL_INTERVAL_SEC = 30;

/** Normalised SEP-24 terminal states that stop further polling. */
const ANCHOR_POLL_TERMINAL = new Set([...TERMINAL_ANCHOR_STATUSES, "incomplete"]);

/**
 * Poll pending SEP-24 anchor sessions and reconcile remote status with
 * local records.
 *
 * Design:
 * - Only discover sessions that haven't been polled in the last 30 seconds.
 * - Claim each session with a short-lived database lease
 *   (claimedAt/claimedBy/leaseExpiresAt) before polling it, so two worker
 *   processes can never poll — and racily write — the same session at once.
 *   An expired lease (e.g. left behind by a crashed worker) is automatically
 *   reclaimable by any worker on the next cycle; no separate recovery pass
 *   is needed.
 * - Never overwrite a terminal status with a non-terminal one.
 * - Retry failures with bounded backoff tracked via retryCount.
 * - Store error details in failureReason for support.
 * - Emit audit log events when a terminal status is reached via polling.
 */
export async function reconcileAnchors(): Promise<void> {
  const cutoff = new Date(Date.now() - ANCHOR_MIN_POLL_INTERVAL_SEC * 1000);

  const sessions = await prisma.anchorSession.findMany({
    where: {
      anchorToken: { not: null },
      externalTransactionId: { not: null },
      status: { notIn: [...ANCHOR_POLL_TERMINAL] },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lt: cutoff } }],
    },
    take: ANCHOR_POLL_BATCH_SIZE,
    orderBy: { lastPolledAt: "asc" as const },
  });

  if (sessions.length === 0) return;

  let toml;
  try {
    toml = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
  } catch {
    // Can't reach the anchor at all — skip this cycle.
    return;
  }

  for (const session of sessions) {
    if (claimedAnchors.has(session.id)) continue;

    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + config.WORKER_LEASE_TIMEOUT_MS);
    const claim = await prisma.anchorSession.updateMany({
      where: {
        id: session.id,
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { claimedAt: now, claimedBy: WORKER_ID, leaseExpiresAt },
    });
    if (claim.count === 0) continue;

    claimedAnchors.add(session.id);
    const ctx = jobContext("anchor", session.id);
    const sessionLog = loggerWithContext(log, ctx);

    try {
      await reconcileSingleAnchor(session, toml.transferServerSep24, sessionLog);
    } catch (err) {
      // Individual session errors should not block the rest of the batch.
      const message = err instanceof Error ? err.message : String(err);
      sessionLog.error(
        { sessionId: session.id, externalId: session.externalTransactionId, err: message },
        "unexpected error reconciling anchor session"
      );
    } finally {
      claimedAnchors.delete(session.id);
      await prisma.anchorSession
        .updateMany({
          where: { id: session.id, claimedBy: WORKER_ID },
          data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
        })
        .catch(() => {});
    }
  }
}

/**
 * Poll a single anchor session and advance its status.
 */
async function reconcileSingleAnchor(
  session: {
    id: string;
    externalTransactionId: string | null;
    anchorToken: string | null;
    status: string;
    retryCount: number;
    failureReason: string | null;
  },
  transferServer: string,
  jobLog: ReturnType<typeof loggerWithContext>
): Promise<void> {
  // Guard against null fields (shouldn't happen due to query filter, but safety first)
  if (!session.anchorToken || !session.externalTransactionId) {
    jobLog.warn(
      { sessionId: session.id },
      "skipping anchor session with missing token or externalTransactionId"
    );
    return;
  }

  const result: PollResult = await anchorService.pollTransaction({
    transferServer,
    token: session.anchorToken,
    id: session.externalTransactionId,
  });

  const now = new Date();

  // ── Handle poll errors (timeout, network, malformed) ─────────────────
  if (result.isError) {
    const nextRetryCount = session.retryCount + 1;
    const shouldBackoff = nextRetryCount <= ANCHOR_MAX_RETRIES;

    const data: Record<string, unknown> = {
      lastPolledAt: now,
      retryCount: shouldBackoff ? nextRetryCount : session.retryCount,
      failureReason: result.message,
      errorCategory: "transient",
    };
    if (!shouldBackoff) {
      data.status = "error";
      data.errorCategory = "permanent";
    }

    await prisma.anchorSession.update({ where: { id: session.id }, data });

    if (!shouldBackoff) {
      jobLog.warn(
        {
          sessionId: session.id,
          externalId: session.externalTransactionId,
          retryCount: session.retryCount,
          reason: result.message,
        },
        "anchor session marked as error after exhausting retries"
      );
      await audit({
        action: "anchor.session.failed",
        entityType: "anchor_session",
        entityId: session.id,
        metadata: {
          previousStatus: session.status,
          status: "error",
          failureReason: result.message,
          retryCount: nextRetryCount,
        },
      });
    }
    return;
  }

  // ── Status unchanged ─────────────────────────────────────────────────
  if (result.status === session.status) {
    await prisma.anchorSession.update({
      where: { id: session.id },
      data: {
        lastPolledAt: now,
        failureReason: null, // clear transient errors if poll succeeds
        errorCategory: null,
      },
    });
    return;
  }

  // ── Terminal-state protection ───────────────────────────────────────
  // If the local record is already in a terminal state and the anchor
  // reports something else, trust the local record.
  if (TERMINAL_ANCHOR_STATUSES.has(session.status)) {
    jobLog.warn(
      {
        sessionId: session.id,
        localStatus: session.status,
        remoteStatus: result.status,
        rawStatus: result.rawStatus,
      },
      "anchor poll returned non-terminal status for terminal session; ignoring"
    );
    return;
  }

  // ── Advance status ──────────────────────────────────────────────────
  const updateData: Record<string, unknown> = {
    status: result.status,
    lastPolledAt: now,
    failureReason: result.status === "error" ? (result.message ?? null) : null,
    retryCount: 0, // reset on successful poll
    errorCategory: null,
    nextAttemptAt: null,
  };

  if (result.stellarTransactionHash) {
    jobLog.debug(
      { sessionId: session.id, hash: result.stellarTransactionHash },
      "anchor reported stellar transaction hash"
    );
  }

  await prisma.anchorSession.update({ where: { id: session.id }, data: updateData });

  jobLog.info(
    {
      sessionId: session.id,
      externalId: session.externalTransactionId,
      fromStatus: session.status,
      toStatus: result.status,
    },
    result.message
  );

  // ── Audit on terminal transitions ───────────────────────────────────
  if (AUDITABLE_ANCHOR_STATUSES.has(result.status)) {
    await audit({
      action: `anchor.session.${result.status}`,
      entityType: "anchor_session",
      entityId: session.id,
      metadata: {
        previousStatus: session.status,
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

// ---------------------------------------------------------------------------
// Misc jobs
// ---------------------------------------------------------------------------

export async function expireInvites(): Promise<void> {
  await prisma.invite.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
}

export async function runWorkerCycle(): Promise<void> {
  await Promise.all([
    runReconciliation(),
    reconcileAnchors(),
    processSubmittedSettlements(),
    reconcileSettlements(),
    expireInvites(),
  ]);
}

export function startWorker(): () => void {
  const stopReconciliation = startReconciliation();
  const timer = setInterval(() => {
    void runWorkerCycle().catch((error) => {
      log.error({ reason: safeErrorMessage(error) }, "worker cycle failed");
    });
  }, config.WORKER_INTERVAL_MS);

  void runWorkerCycle().catch((error) => {
    log.error({ reason: safeErrorMessage(error) }, "initial worker cycle failed");
  });

  return () => {
    clearInterval(timer);
    stopReconciliation();
  };
}

if (process.env.NODE_ENV !== "test") {
  startWorker();
}
