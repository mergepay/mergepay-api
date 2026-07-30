import pino from "pino";
import { randomUUID } from "crypto";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import { AppError } from "../errors";
import {
  anchorService,
  mapAnchorStatus,
  TERMINAL_ANCHOR_STATUSES,
  AUDITABLE_ANCHOR_STATUSES,
} from "../services/anchor";
import type { PollResult } from "../services/anchor";
import { runReconciliation, startReconciliation } from "./reconciliation";
import { classifyJobFailure, retryDelayMs, SETTLEMENT_RETRY_POLICY } from "../services/job-retry";
import { TimeoutError, TransportError } from "../services/timeout";

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

const WORKER_ID = randomUUID();
const claimedSettlements = new Set<string>();
const claimedAnchors = new Set<string>();
let isShuttingDown = false;

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

function isPermanentSettlementFailure(error: unknown): boolean {
  if (error instanceof PermanentSettlementError) return true;
  if (error instanceof AppError) {
    return error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429;
  }

  const message = safeErrorMessage(error).toLowerCase();
  return (
    message.includes("invalid") ||
    message.includes("malformed") ||
    message.includes("xdr_mismatch") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("not authorized") ||
    message.includes("bad request") ||
    message.includes("signature") ||
    message.includes("destination")
  );
}

function isTransientSettlementFailure(error: unknown): boolean {
  if (isPermanentSettlementFailure(error)) return false;
  if (error instanceof AppError) {
    return error.statusCode === 429 || error.statusCode >= 500;
  }

  const message = safeErrorMessage(error).toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("rate_limit") ||
    message.includes("rate limit") ||
    message.includes("stale") ||
    message.includes("connection") ||
    message.includes("network") ||
    message.includes("temporar") ||
    message.includes("unavailable") ||
    message.includes("horizon") ||
    message.includes("retry")
  );
}

async function recordTransition(
  id: string,
  action: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await audit({
    action,
    entityType: "settlement",
    entityId: id,
    metadata,
  });
}

async function claimSettlement(settlement: SettlementSubmissionRecord): Promise<boolean> {
  if (isShuttingDown) return false;
  if (claimedSettlements.has(settlement.id)) return true;

  const now = new Date();
  const leaseExpiresAt = new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS);

  const result = await prisma.settlement.updateMany({
    where: {
      id: settlement.id,
      status: { in: ["pending", "submitted"] },
      OR: [
        { leaseExpiresAt: null },
        { leaseExpiresAt: { lt: now } },
      ],
    },
    data: {
      claimedAt: now,
      claimedBy: WORKER_ID,
      leaseExpiresAt,
      retryCount: { increment: 1 },
    },
  });

  if (result.count !== 1) return false;
  claimedSettlements.add(settlement.id);
  settlement.retryCount += 1;
  return true;
}

async function releaseSettlementClaim(id: string): Promise<void> {
  claimedSettlements.delete(id);
  if (!isShuttingDown) {
    await prisma.settlement.updateMany({
      where: { id, claimedBy: WORKER_ID },
      data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
    }).catch(() => {});
  }
}

export async function submitSettlement(
  settlement: SettlementSubmissionRecord,
  retryAttempt: number
): Promise<string> {
  if (!settlement.transactionXdr) {
    throw new PermanentSettlementError("settlement has no transaction XDR");
  }

  try {
    const hash = await stellar.submitPayment(settlement.transactionXdr, {
      sourcePublicKey: settlement.fromPublicKey,
      destination: settlement.toPublicKey,
      asset: { code: settlement.assetCode, issuer: settlement.assetIssuer },
      amount: settlement.amount,
      memoCode: settlement.shortCode,
    });
    log.info({ id: settlement.id, hash }, "settlement submitted successfully");
    return hash;
  } catch (error) {
    if (!isTransientSettlementFailure(error) || retryAttempt >= SETTLEMENT_MAX_RETRIES) {
      throw new PermanentSettlementError(safeErrorMessage(error));
    }
    throw error;
  }
}

async function markSettlementFailed(
  settlement: SettlementSubmissionRecord,
  message: string,
  terminal: boolean = false
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlement.id },
    data: {
      status: "failed",
      failureReason: message,
      retryCount: settlement.retryCount,
      claimedAt: null,
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });
  await recordTransition(settlement.id, "settlement_failed", {
    attempt: settlement.retryCount,
    reason: message,
    terminal,
  });
  log.error(
    { id: settlement.id, attempt: settlement.retryCount, reason: message, terminal },
    "settlement failed"
  );
}

async function processSettlement(settlement: SettlementSubmissionRecord): Promise<void> {
  if (!(await claimSettlement(settlement))) return;

  try {
    const initialAttempt = Math.max(1, settlement.retryCount);
    const remainingAttempts = Math.max(1, SETTLEMENT_MAX_RETRIES - initialAttempt + 1);

    for (let offset = 0; offset < remainingAttempts; offset += 1) {
      const attempt = initialAttempt + offset;
      try {
        const hash = await submitSettlement(settlement, attempt);
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            status: "confirmed",
            stellarTxHash: hash,
            retryCount: attempt,
            claimedAt: null,
            claimedBy: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
          },
        });
        await recordTransition(settlement.id, "settlement_confirmed", { attempt });
        return;
      } catch (error) {
        const message = safeErrorMessage(error);
        const failureCategory = classifyJobFailure(error);
        const permanent = failureCategory === "permanent" || attempt >= SETTLEMENT_MAX_RETRIES;

        if (permanent) {
          await markSettlementFailed(settlement, message, true);
          return;
        }

        const delay = retryDelayMs(attempt, SETTLEMENT_RETRY_POLICY);
        const nextAttemptAt = new Date(Date.now() + delay);
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: { 
            retryCount: attempt,
            nextAttemptAt,
            leaseExpiresAt: new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS),
          },
        });
        await recordTransition(settlement.id, "settlement_retry_scheduled", {
          attempt,
          nextDelayMs: delay,
          nextAttemptAt: nextAttemptAt.toISOString(),
          reason: message,
          failureCategory,
        });
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
    
    // Claim the session with a lease
    const now = new Date();
    const leaseExpiresAt = new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS);
    const claimResult = await prisma.anchorSession.updateMany({
      where: {
        id: session.id,
        OR: [
          { leaseExpiresAt: null },
          { leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        claimedAt: now,
        claimedBy: WORKER_ID,
        leaseExpiresAt,
      },
    });

    if (claimResult.count === 0) continue;
    claimedAnchors.add(session.id);

    try {
      await reconcileSingleAnchor(session, toml.transferServerSep24);
    } catch (err) {
      // Individual session errors should not block the rest of the batch.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { sessionId: session.id, externalId: session.externalTransactionId, err: message },
        "unexpected error reconciling anchor session"
      );
    } finally {
      claimedAnchors.delete(session.id);
      if (!isShuttingDown) {
        await prisma.anchorSession.updateMany({
          where: { id: session.id, claimedBy: WORKER_ID },
          data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
        }).catch(() => {});
      }
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
  transferServer: string
): Promise<void> {
  // Guard against null fields (shouldn't happen due to query filter, but safety first)
  if (!session.anchorToken || !session.externalTransactionId) {
    log.warn(
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
      log.warn(
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
    log.warn(
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
    log.debug(
      { sessionId: session.id, hash: result.stellarTransactionHash },
      "anchor reported stellar transaction hash"
    );
  }

  await prisma.anchorSession.update({
    where: { id: session.id },
    data: updateData as any,
  });

  log.info(
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
  const now = new Date();
  const settlements = await prisma.settlement.findMany({
    where: {
      status: { in: ["pending", "submitted"] },
      transactionXdr: { not: null },
      OR: [
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: now } },
      ],
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
      expenseShareId: row.expenseShareId,
      retryCount: row.retryCount,
      status: row.status,
      createdAt: row.createdAt,
    };
    await processSettlement(settlement);
  }
}

export async function runWorkerCycle(): Promise<void> {
  await Promise.all([
    reconcilePending(),
    reconcileAnchors(),
    processSubmittedSettlements(),
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

  const shutdown = async () => {
    isShuttingDown = true;
    log.info("worker shutdown initiated, releasing claims...");
    
    // Release all claims
    const releasePromises = [
      prisma.settlement.updateMany({
        where: { claimedBy: WORKER_ID },
        data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
      }),
      prisma.anchorSession.updateMany({
        where: { claimedBy: WORKER_ID },
        data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
      }),
    ];
    
    await Promise.allSettled(releasePromises);
    log.info("worker claims released");
    
    clearInterval(timer);
    reconciliationStop();
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  return shutdown;
}

if (process.env.NODE_ENV !== "test") {
  startWorker();
}
