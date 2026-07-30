import pino from "pino";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import { AppError } from "../lib/errors";
import {
  anchorService,
  mapAnchorStatus,
  TERMINAL_ANCHOR_STATUSES,
  AUDITABLE_ANCHOR_STATUSES,
} from "../services/anchor";
import type { PollResult } from "../services/anchor";
import { runReconciliation, startReconciliation } from "./reconciliation";

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
  nextRetryAt: Date | null;
  errorCategory: string | null;
  createdAt: Date;
}

const log = pino({ name: "worker" });

export const SETTLEMENT_MAX_RETRIES = 3;
export const ANCHOR_MAX_RETRIES = 3;
const ANCHOR_POLL_BATCH_SIZE = 50;
const ANCHOR_MIN_POLL_INTERVAL_SEC = 30;

/** Base retry delay in milliseconds */
const BASE_RETRY_DELAY_MS = 1_000;
/** Maximum retry delay in milliseconds (capped exponential backoff) */
const MAX_RETRY_DELAY_MS = 60_000;

/** Error categories for classification */
enum ErrorCategory {
  TRANSIENT = "transient",
  PERMANENT = "permanent",
  RATE_LIMIT = "rate_limit",
}

/** Injectable delay function for testing */
let delayFn: (ms: number) => Promise<void> = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export function setDelayFn(fn: (ms: number) => Promise<void>): void {
  delayFn = fn;
}

class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSettlementError";
  }
}

/** Calculate exponential backoff delay with jitter */
function calculateBackoff(attempt: number): number {
  const exponentialDelay = Math.min(
    BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
    MAX_RETRY_DELAY_MS
  );
  // Add jitter: ±25% of the delay
  const jitter = exponentialDelay * 0.25 * (Math.random() * 2 - 1);
  return Math.max(BASE_RETRY_DELAY_MS, exponentialDelay + jitter);
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bearer\s+[a-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/(?:secret|token|password|private[_ -]?key)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function classifyError(error: unknown): ErrorCategory {
  if (error instanceof PermanentSettlementError) {
    return ErrorCategory.PERMANENT;
  }
  if (error instanceof AppError) {
    if (error.statusCode === 429) return ErrorCategory.RATE_LIMIT;
    if (error.statusCode >= 500) return ErrorCategory.TRANSIENT;
    if (error.statusCode >= 400 && error.statusCode < 500) return ErrorCategory.PERMANENT;
  }

  const message = safeErrorMessage(error).toLowerCase();
  
  // Permanent errors
  if (
    message.includes("invalid") ||
    message.includes("malformed") ||
    message.includes("xdr_mismatch") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("not authorized") ||
    message.includes("bad request") ||
    message.includes("signature") ||
    message.includes("destination")
  ) {
    return ErrorCategory.PERMANENT;
  }

  // Rate limit errors
  if (
    message.includes("rate_limit") ||
    message.includes("rate limit")
  ) {
    return ErrorCategory.RATE_LIMIT;
  }

  // Transient errors
  if (
    message.includes("timeout") ||
    message.includes("timed out") ||
    message.includes("stale") ||
    message.includes("connection") ||
    message.includes("network") ||
    message.includes("temporar") ||
    message.includes("unavailable") ||
    message.includes("horizon") ||
    message.includes("retry")
  ) {
    return ErrorCategory.TRANSIENT;
  }

  // Default to permanent for unknown errors
  return ErrorCategory.PERMANENT;
}

function isRetryableError(category: ErrorCategory): boolean {
  return category === ErrorCategory.TRANSIENT || category === ErrorCategory.RATE_LIMIT;
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

/**
 * Claim a settlement using optimistic locking via database update.
 * Returns true if the claim was successful, false if another worker claimed it.
 */
async function claimSettlement(
  settlement: SettlementSubmissionRecord
): Promise<boolean> {
  const now = new Date();
  const nextRetryAt = settlement.nextRetryAt;
  
  // Skip if not yet ready for retry
  if (nextRetryAt && nextRetryAt > now) {
    return false;
  }

  const result = await prisma.settlement.updateMany({
    where: {
      id: settlement.id,
      status: { in: ["pending", "submitted"] },
      retryCount: settlement.retryCount,
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
      ],
    },
    data: {
      retryCount: { increment: 1 },
      nextRetryAt: null,
      errorCategory: null,
    },
  });

  return result.count === 1;
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
    const category = classifyError(error);
    if (!isRetryableError(category) || retryAttempt >= SETTLEMENT_MAX_RETRIES) {
      throw new PermanentSettlementError(safeErrorMessage(error));
    }
    throw error;
  }
}

async function markSettlementFailed(
  settlement: SettlementSubmissionRecord,
  message: string,
  category: ErrorCategory
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlement.id },
    data: {
      status: "failed",
      retryCount: settlement.retryCount,
      failureReason: message,
      errorCategory: category,
      nextRetryAt: null,
    },
  });
  await recordTransition(settlement.id, "settlement_failed", {
    attempt: settlement.retryCount,
    reason: message,
    errorCategory: category,
  });
  log.error(
    { id: settlement.id, attempt: settlement.retryCount, reason: message, category },
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
            failureReason: null,
            errorCategory: null,
            nextRetryAt: null,
          },
        });
        await recordTransition(settlement.id, "settlement_confirmed", { attempt });
        return;
      } catch (error) {
        const message = safeErrorMessage(error);
        const category = classifyError(error);
        const permanent = !isRetryableError(category) || attempt >= SETTLEMENT_MAX_RETRIES;

        if (permanent) {
          await markSettlementFailed(settlement, message, category);
          return;
        }

        const delayMs = calculateBackoff(attempt);
        const nextRetryAt = new Date(Date.now() + delayMs);
        
        await prisma.settlement.update({
          where: { id: settlement.id },
          data: {
            retryCount: attempt,
            failureReason: message,
            errorCategory: category,
            nextRetryAt,
          },
        });
        await recordTransition(settlement.id, "settlement_retry_scheduled", {
          attempt,
          nextDelayMs: delayMs,
          nextRetryAt: nextRetryAt.toISOString(),
          reason: message,
          errorCategory: category,
        });
        await delayFn(delayMs);
      }
    }
  } catch (error) {
    // Unexpected error in processing logic - mark as failed
    const message = safeErrorMessage(error);
    const category = classifyError(error);
    await markSettlementFailed(settlement, message, category);
  }
}

export async function reconcilePending(): Promise<void> {
  await runReconciliation();
}

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
 * - Use optimistic locking for concurrent worker safety.
 */
export async function reconcileAnchors(): Promise<void> {
  const cutoff = new Date(
    Date.now() - ANCHOR_MIN_POLL_INTERVAL_SEC * 1000
  );
  const now = new Date();

  const sessions = await prisma.anchorSession.findMany({
    where: {
      anchorToken: { not: null },
      externalTransactionId: { not: null },
      status: { notIn: [...ANCHOR_POLL_TERMINAL] },
      AND: [
        {
          OR: [
            { lastPolledAt: null },
            { lastPolledAt: { lt: cutoff } },
          ],
        },
        {
          OR: [
            { nextRetryAt: null },
            { nextRetryAt: { lte: now } },
          ],
        },
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
    try {
      await reconcileSingleAnchor(session, toml.transferServerSep24);
    } catch (err) {
      // Individual session errors should not block the rest of the batch.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { sessionId: session.id, externalId: session.externalTransactionId, err: message },
        "unexpected error reconciling anchor session"
      );
    }
  }
}

/**
 * Claim an anchor session using optimistic locking.
 */
async function claimAnchorSession(
  session: { id: string; retryCount: number; nextRetryAt: Date | null }
): Promise<boolean> {
  const now = new Date();
  
  // Skip if not yet ready for retry
  if (session.nextRetryAt && session.nextRetryAt > now) {
    return false;
  }

  const result = await prisma.anchorSession.updateMany({
    where: {
      id: session.id,
      retryCount: session.retryCount,
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
      ],
    },
    data: {
      retryCount: { increment: 1 },
      nextRetryAt: null,
      errorCategory: null,
    },
  });

  return result.count === 1;
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
    nextRetryAt: Date | null;
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

  // Try to claim the session
  if (!(await claimAnchorSession(session))) {
    return; // Another worker claimed it or not ready for retry
  }

  const result: PollResult = await anchorService.pollTransaction({
    transferServer,
    token: session.anchorToken!,
    id: session.externalTransactionId!,
  });

  const now = new Date();
  const currentRetryCount = session.retryCount + 1;

  // ── Handle poll errors (timeout, network, malformed) ─────────────────
  if (result.isError) {
    const shouldBackoff = currentRetryCount <= ANCHOR_MAX_RETRIES;
    const category = ErrorCategory.TRANSIENT; // Poll errors are typically transient

    const data: Record<string, unknown> = {
      lastPolledAt: now,
      retryCount: currentRetryCount,
      failureReason: result.message,
      errorCategory: category,
    };

    if (shouldBackoff) {
      const delayMs = calculateBackoff(currentRetryCount);
      data.nextRetryAt = new Date(Date.now() + delayMs);
    } else {
      data.status = "error";
      data.nextRetryAt = null;
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
          retryCount: currentRetryCount,
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
          retryCount: currentRetryCount,
          errorCategory: category,
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
        nextRetryAt: null,
        retryCount: 0, // reset on successful poll
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
    errorCategory: null,
    nextRetryAt: null,
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
      // Only process settlements that are ready for retry
      OR: [
        { nextRetryAt: null },
        { nextRetryAt: { lte: now } },
      ],
    },
    include: {
      from: { select: { stellarPublicKey: true } },
      to: { select: { stellarPublicKey: true } },
    },
    take: 50,
    orderBy: { nextRetryAt: "asc" as const },
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
      nextRetryAt: row.nextRetryAt,
      errorCategory: row.errorCategory,
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

  return () => {
    clearInterval(timer);
    reconciliationStop();
  };
}

if (process.env.NODE_ENV !== "test") {
  startWorker();
}
