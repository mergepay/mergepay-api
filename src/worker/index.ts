import pino from "pino";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import { anchorService, mapAnchorStatus } from "../services/anchor";
import { AppError } from "../lib/errors";
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
  if (claimedSettlements.has(settlement.id)) return false;

  const model = prisma.settlement as any;
  if (typeof model.updateMany !== "function") {
    claimedSettlements.add(settlement.id);
    return true;
  }

  const result = await model.updateMany({
    where: {
      id: settlement.id,
      status: { in: ["pending", "submitted"] },
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

export async function submitSettlement(
  settlement: SettlementSubmissionRecord,
  retryAttempt: number
): Promise<string> {
  if (!settlement.transactionXdr) {
    throw new PermanentSettlementError("settlement has no transaction XDR");
  }

  try {
    const hash = await stellar.submitPayment(settlement.transactionXdr);
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
  message: string
): Promise<void> {
  await prisma.settlement.update({
    where: { id: settlement.id },
    data: {
      status: "failed",
      retryCount: settlement.retryCount,
    },
  });
  await recordTransition(settlement.id, "settlement_failed", {
    attempt: settlement.retryCount,
    reason: message,
  });
  log.error(
    { id: settlement.id, attempt: settlement.retryCount, reason: message },
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
          },
        });
        await recordTransition(settlement.id, "settlement_confirmed", { attempt });
        return;
      } catch (error) {
        const message = safeErrorMessage(error);
        const permanent = isPermanentSettlementFailure(error) || attempt >= SETTLEMENT_MAX_RETRIES;

        if (permanent) {
          await markSettlementFailed(settlement, message);
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

export async function reconcileAnchors(): Promise<void> {
  const sessions = await prisma.anchorSession.findMany({
    where: {
      anchorToken: { not: null },
      externalTransactionId: { not: null },
      status: { notIn: ["completed", "error", "refunded"] },
    },
    take: 50,
  });

  if (sessions.length === 0) return;

  let toml;
  try {
    toml = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
  } catch (error) {
    log.warn(
      { reason: safeErrorMessage(error) },
      "anchor metadata unavailable; polling will resume later"
    );
    return;
  }

  for (const session of sessions) {
    if (claimedAnchors.has(session.id)) continue;
    claimedAnchors.add(session.id);

    try {
      const status = await anchorService.getTransactionStatus({
        transferServer: toml.transferServerSep24,
        token: session.anchorToken!,
        id: session.externalTransactionId!,
      });

      if (status) {
        const mappedStatus = mapAnchorStatus(status);
        await prisma.anchorSession.update({
          where: { id: session.id },
          data: { status: mappedStatus },
        });
        await audit({
          action: "anchor_status_updated",
          entityType: "anchor_session",
          entityId: session.id,
          metadata: { status: mappedStatus },
        });
      }
    } catch (error) {
      log.warn(
        { id: session.id, reason: safeErrorMessage(error) },
        "anchor status check failed; will retry later"
      );
    } finally {
      claimedAnchors.delete(session.id);
    }
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
      status: { in: ["pending", "submitted"] },
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
      amount: row.amount,
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

  return () => {
    clearInterval(timer);
    reconciliationStop();
  };
}

if (process.env.NODE_ENV !== "test") {
  startWorker();
}
