import pino from "pino";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import { AppError } from "../errors";
import {
  applySettlementTransition,
  classifySettlementError,
} from "../services/settlement-machine";
import { pollForConfirmation } from "../services/horizon-confirm";
import {
  anchorService,
  mapAnchorStatus,
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
  expenseShareId: string | null;
  retryCount: number;
  status: string;
  createdAt: Date;
}

const log = pino({ name: "worker" });

export const SETTLEMENT_MAX_RETRIES = 3;
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

const claimedSettlements = new Set<string>();
const claimedAnchors = new Set<string>();

class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSettlementError";
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bearer\s+[a-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/(?:secret|token|password|private[_ -]?key)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

async function claimSettlement(settlement: SettlementSubmissionRecord): Promise<boolean> {
  if (claimedSettlements.has(settlement.id)) return false;

  const model = prisma.settlement as any;
  if (typeof model.updateMany !== "function") {
    claimedSettlements.add(settlement.id);
    return true;
  }

  const result = await model.updateMany({
    where: {
      id: settlement.id,
      status: { in: ["submitted", "verifying"] },
      retryCount: settlement.retryCount,
    },
    data: { retryCount: { increment: 1 } },
  });

  if (result.count !== 1) return false;
  claimedSettlements.add(settlement.id);
  settlement.retryCount += 1;
  return true;
}

async function releaseSettlementClaim(id: string): Promise<void> {
  claimedSettlements.delete(id);
}

async function markSettlementFailed(
  settlement: SettlementSubmissionRecord,
  message: string
): Promise<void> {
  await applySettlementTransition({
    settlementId: settlement.id,
    nextStatus: "failed",
    source: "worker",
    extraData: {
      failureReason: message,
    },
  });
  log.error(
    { id: settlement.id, attempt: settlement.retryCount, reason: message },
    "settlement failed"
  );
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
  settlement: SettlementSubmissionRecord,
  message: string,
  ctx?: CorrelationContext
): Promise<void> {
  const jobLog = loggerWithContext(log, ctx);

  await prisma.settlement.update({
    where: { id: settlement.id },
    data: {
      status: "failed",
      retryCount: settlement.retryCount,
      failureReason: message,
    },
  });
  await recordTransition(settlement.id, "settlement_failed", {
    attempt: settlement.retryCount,
    reason: message,
  });
  jobLog.error(
    { id: settlement.id, attempt: settlement.retryCount, reason: message },
    "settlement failed"
  );
}

async function processSettlement(
  settlement: SettlementSubmissionRecord,
  ctx?: CorrelationContext
): Promise<void> {
  if (!(await claimSettlement(settlement))) return;

  const jobLog = loggerWithContext(log, ctx);

  try {
    if (settlement.status === "submitted") {
      await applySettlementTransition({
        settlementId: settlement.id,
        nextStatus: "verifying",
        source: "worker",
      });
    }

    const initialAttempt = Math.max(1, settlement.retryCount);
    const remainingAttempts = Math.max(1, SETTLEMENT_MAX_RETRIES - initialAttempt + 1);

    for (let offset = 0; offset < remainingAttempts; offset += 1) {
      const attempt = initialAttempt + offset;
      try {
        const hash = await submitSettlement(settlement, attempt, ctx);
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: "pending_confirmation",
            stellarTxHash: hash,
            retryCount: 0,
          },
        });
        await audit({
          userId: null,
          action: "settlement.submitted_to_stellar",
          entityType: "settlement",
          entityId: settlement.id,
          metadata: { stellarTxHash: hash, attempt },
        });
        jobLog.info({ id: settlement.id, hash, attempt }, "settlement submitted to Stellar");
        return;
      } catch (error) {
        const message = safeErrorMessage(error);
        const permanent =
          error instanceof PermanentSettlementError ||
          classifySettlementError(error) === "permanent" ||
          attempt >= SETTLEMENT_MAX_RETRIES;

        if (permanent) {
          await markSettlementFailed(settlement, message, ctx);
          return;
        }

        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: { retryCount: attempt },
        });
        await recordTransition(settlement.id, "settlement_retry_scheduled", {
          attempt,
          nextDelayMs: delay,
          reason: message,
        });
        jobLog.warn(
          { id: settlement.id, attempt, nextRetryDelayMs: delay, reason: message },
          "settlement retry scheduled"
        );
        await sleep(delay);
      }
    }
  } finally {
    await releaseSettlementClaim(settlement.id);
  }
}

export async function reconcilePending(): Promise<void> {
  await runReconciliation();
}

/** Maximum number of failed poll attempts before marking a session as error. */
const ANCHOR_MAX_RETRIES = 3;
const ANCHOR_POLL_BATCH_SIZE = 50;

/**
 * Minimum interval between polls for the same session (seconds).
 * Sessions polled more recently than this are skipped.
 */
const ANCHOR_MIN_POLL_INTERVAL_SEC = 30;

/** Normalised SEP-24 terminal states that stop further polling. */
const ANCHOR_POLL_TERMINAL = new Set([
  ...TERMINAL_ANCHOR_STATUSES,
  "incomplete", // before we have an external id
]);

/**
 * Poll pending SEP-24 anchor sessions and reconcile remote status with
 * local records.
 *
 * Design:
 * - Only discover sessions that haven't been polled in the last 30 seconds.
 * - Never overwrite a terminal status with a non-terminal one.
 * - Retry failures with bounded exponential backoff tracked via retryCount.
 * - Store error details in failureReason for support.
 * - Emit audit log events when a terminal status is reached via polling.
 */
export async function reconcileAnchors(): Promise<void> {
  const cutoff = new Date(
    Date.now() - ANCHOR_MIN_POLL_INTERVAL_SEC * 1000
  );

  const sessions = await prisma.anchorSession.findMany({
    where: {
      anchorToken: { not: null },
      externalTransactionId: { not: null },
      status: { notIn: [...ANCHOR_POLL_TERMINAL] },
      OR: [
        { lastPolledAt: null },
        { lastPolledAt: { lt: cutoff } },
      ],
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
    claimedAnchors.add(session.id);

    const ctx = jobContext("anchor", session.id);
    const sessionLog = loggerWithContext(log, ctx);

    try {
      await reconcileSingleAnchor(session, toml.transferServerSep24, ctx);
    } catch (err) {
      // Individual session errors should not block the rest of the batch.
      const message = err instanceof Error ? err.message : String(err);
      sessionLog.error(
        { sessionId: session.id, externalId: session.externalTransactionId, err: message },
        "unexpected error reconciling anchor session"
      );
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
  ctx?: CorrelationContext
): Promise<void> {
  // Guard against null fields (shouldn't happen due to query filter, but safety first)
  const jobLog = loggerWithContext(log, ctx);
  if (!session.anchorToken || !session.externalTransactionId) {
    jobLog.warn(
      { sessionId: session.id },
      "skipping anchor session with missing token or externalTransactionId"
    );
    return;
  }
  const result: PollResult = await anchorService.pollTransaction({
    transferServer,
    token: session.anchorToken!,
    id: session.externalTransactionId!,
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
    };

    // If we've exhausted retries, mark as error.
    if (!shouldBackoff) {
      data.status = "error";
    }

    await prisma.anchorSession.update({
      where: { id: session.id },
      data: data as any,
    });

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
  };

  if (result.stellarTransactionHash) {
    jobLog.debug(
      { sessionId: session.id, hash: result.stellarTransactionHash },
      "anchor reported stellar transaction hash"
    );
  }

  await prisma.anchorSession.update({
    where: { id: session.id },
    data: updateData as any,
  });

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

export async function expireInvites(): Promise<void> {
  await prisma.invite.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
}

export async function processSubmittedSettlements(): Promise<void> {
  const settlements = await prisma.settlement.findMany({
    where: {
      status: { in: ["submitted", "verifying"] },
      transactionXdr: { not: null },
    },
    include: {
      from: { select: { stellarPublicKey: true } },
      to: { select: { stellarPublicKey: true } },
    },
    take: 50,
  });

  for (const row of settlements) {
    const settlement: SettlementSubmissionRecord = {
      id: row.id,
      shortCode: row.shortCode,
      fromPublicKey: row.from.stellarPublicKey,
      toPublicKey: row.to.stellarPublicKey,
      amount: String(row.amount),
      assetCode: row.assetCode,
      assetIssuer: row.assetIssuer,
      transactionXdr: row.transactionXdr,
      expenseShareId: row.expenseShareId,
      retryCount: row.retryCount,
      status: row.status,
      createdAt: row.createdAt,
    };
    const ctx = jobContext("settlement", row.id);
    await processSettlement(settlement, ctx);
  }
}

export async function runWorkerCycle(): Promise<void> {
  await Promise.all([
    reconcilePending(),
    reconcileAnchors(),
    processSubmittedSettlements(),
    reconcileSettlements(),
    expireInvites(),
  ]);
}

export function startWorker(): () => void {
  const reconciliationStop = startReconciliation();
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
    reconciliationStop();
  };
}

if (process.env.NODE_ENV !== "test") {
  startWorker();
}
