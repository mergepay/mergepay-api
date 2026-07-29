import pino from "pino";
import { AppError } from "../errors";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import {
  anchorService,
  mapAnchorStatus,
} from "../services/anchor";
import { applyAnchorSessionTransition } from "../services/anchor-status";
import {
  classifyJobFailure,
  failureTransactionHash,
  retryDelayMs,
  SETTLEMENT_RETRY_POLICY,
} from "../services/job-retry";
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

export const SETTLEMENT_MAX_RETRIES = SETTLEMENT_RETRY_POLICY.maxAttempts;
export const RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function correlationId(settlementId: string): string {
  return `settlement-${settlementId}-${Date.now().toString(36)}`;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/bearer\s+[a-z0-9._-]+/gi, "bearer [redacted]")
    .replace(/(?:secret|token|password|private[_ -]?key)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/(?:xdr|transaction)[=:]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(0, 500);
}

function isPermanentSettlementFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.statusCode >= 400 && error.statusCode < 500 && error.statusCode !== 429;
  }
  return classifyJobFailure(error) === "permanent";
}

function isRetryableSettlementFailure(error: unknown): boolean {
  if (isPermanentSettlementFailure(error)) return false;
  const category = classifyJobFailure(error);
  return category === "transient" || category === "indeterminate";
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
  const model = prisma.settlement as any;
  if (typeof model.updateMany !== "function") return false;

  const result = await model.updateMany({
    where: {
      id: settlement.id,
      status: { in: ["pending", "submitted"] },
      retryCount: settlement.retryCount,
    },
    data: { retryCount: { increment: 1 } },
  });

  if (result.count !== 1) return false;
  settlement.retryCount += 1;
  return true;
}

async function persistSettlementFailure(
  settlement: SettlementSubmissionRecord,
  reason: string,
  permanent: boolean,
  id: string
): Promise<void> {
  const model = prisma.settlement as any;
  const nextStatus = permanent || settlement.retryCount >= SETTLEMENT_MAX_RETRIES
    ? "failed"
    : "pending";

  if (typeof model.updateMany === "function") {
    await model.updateMany({
      where: {
        id: settlement.id,
        retryCount: settlement.retryCount,
        status: { in: ["pending", "submitted"] },
      },
      data: {
        status: nextStatus,
        failureReason: reason,
      },
    });
  } else if (typeof model.update === "function") {
    await model.update({
      where: { id: settlement.id },
      data: { status: nextStatus, failureReason: reason },
    });
  }

  await recordTransition(
    settlement.id,
    nextStatus === "failed" ? "settlement.failed" : "settlement.retry_scheduled",
    {
      correlationId: id,
      attempt: settlement.retryCount,
      reason,
      retryable: nextStatus !== "failed",
    }
  );
}

export async function submitSettlement(
  settlement: SettlementSubmissionRecord,
  retryAttempt: number
): Promise<string> {
  if (!settlement.transactionXdr) {
    throw new Error("settlement has no transaction XDR");
  }

  try {
    const hash = await stellar.submitPayment(settlement.transactionXdr, {
      sourcePublicKey: settlement.fromPublicKey,
      destination: settlement.toPublicKey,
      asset: {
        code: settlement.assetCode,
        issuer: settlement.assetIssuer,
      },
      amount: settlement.amount,
      memoCode: settlement.shortCode,
    });

    log.info({ settlementId: settlement.id, attempt: retryAttempt }, "settlement submitted");
    return hash;
  } catch (error) {
    if (isRetryableSettlementFailure(error) && retryAttempt < SETTLEMENT_MAX_RETRIES) {
      throw error;
    }
    throw error;
  }
}

async function markSubmitted(
  settlement: SettlementSubmissionRecord,
  hash: string,
  correlation: string
): Promise<void> {
  const model = prisma.settlement as any;
  if (typeof model.updateMany === "function") {
    await model.updateMany({
      where: { id: settlement.id, retryCount: settlement.retryCount },
      data: { status: "submitted", stellarTxHash: hash, failureReason: null },
    });
  } else if (typeof model.update === "function") {
    await model.update({
      where: { id: settlement.id },
      data: { status: "submitted", stellarTxHash: hash, failureReason: null },
    });
  }

  await recordTransition(settlement.id, "settlement.submitted", {
    correlationId: correlation,
    attempt: settlement.retryCount,
  });
}

export async function processSettlement(
  settlement: SettlementSubmissionRecord
): Promise<boolean> {
  if (settlement.status !== "pending" && settlement.status !== "submitted") return false;
  if (settlement.retryCount >= SETTLEMENT_MAX_RETRIES) {
    await persistSettlementFailure(
      settlement,
      "settlement retry limit exhausted",
      true,
      correlationId(settlement.id)
    );
    return false;
  }

  const claimed = await claimSettlement(settlement);
  if (!claimed) return false;

  const correlation = correlationId(settlement.id);
  try {
    const hash = await submitSettlement(settlement, settlement.retryCount);
    await markSubmitted(settlement, hash, correlation);
    return true;
  } catch (error) {
    const reason = safeErrorMessage(error);
    const permanent = isPermanentSettlementFailure(error);
    const retryable = isRetryableSettlementFailure(error);
    const exhausted = settlement.retryCount >= SETTLEMENT_MAX_RETRIES;

    await persistSettlementFailure(settlement, reason, permanent || !retryable || exhausted, correlation);

    log.error(
      {
        settlementId: settlement.id,
        correlationId: correlation,
        attempt: settlement.retryCount,
        retryable: retryable && !permanent && !exhausted,
        failureCategory: permanent ? "permanent" : retryable ? "transient" : "permanent",
        error: reason,
      },
      "settlement processing failed"
    );

    if (retryable && !permanent && !exhausted) {
      const delay = Number(process.env.SETTLEMENT_RETRY_DELAY_MS ?? retryDelayMs(settlement.retryCount));
      if (delay > 0) await sleep(delay);
    }
    return false;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function processSettlements(): Promise<void> {
  const model = prisma.settlement as any;
  if (typeof model.findMany !== "function") return;

  const settlements = (await model.findMany({
    where: {
      status: { in: ["pending", "submitted"] },
      retryCount: { lt: SETTLEMENT_MAX_RETRIES },
    },
    orderBy: { createdAt: "asc" },
  })) as SettlementSubmissionRecord[];

  for (const settlement of settlements) {
    try {
      await processSettlement(settlement);
    } catch (error) {
      log.error(
        {
          settlementId: settlement.id,
          correlationId: correlationId(settlement.id),
          error: safeErrorMessage(error),
        },
        "settlement worker iteration failed"
      );
    }
  }
}

export async function reconcileAnchors(): Promise<void> {
  const model = prisma.anchorSession as any;
  if (typeof model.findMany !== "function") return;

  const sessions = await model.findMany({
    where: {
      status: { in: ["incomplete", "pending_user_transfer_start", "pending_anchor"] },
      externalTransactionId: { not: null },
    },
  });

  for (const session of sessions) {
    try {
      const toml = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
      const rawStatus = await (anchorService.getTransactionStatus as any)(
        toml.transferServerSep24,
        session.anchorToken,
        session.externalTransactionId
      );
      const nextStatus = mapAnchorStatus(
        typeof rawStatus === "string" ? rawStatus : rawStatus?.status ?? "pending_anchor"
      );

      await applyAnchorSessionTransition({
        sessionId: session.id,
        nextStatus,
        source: "poll",
      });
    } catch (error) {
      log.warn(
        {
          sessionId: session.id,
          error: safeErrorMessage(error),
        },
        "anchor reconciliation failed"
      );
    }
  }
}

export async function runWorkerOnce(): Promise<void> {
  await processSettlements();
  await reconcileAnchors();
  await runReconciliation();
}

export async function startWorker(): Promise<() => void> {
  const stopReconciliation = startReconciliation();
  let stopped = false;

  const loop = async (): Promise<void> => {
    if (stopped) return;
    try {
      await runWorkerOnce();
    } catch (error) {
      log.error({ error: safeErrorMessage(error) }, "worker iteration failed");
    }
    if (!stopped) setTimeout(loop, config.WORKER_INTERVAL_MS);
  };

  await loop();
  return () => {
    stopped = true;
    stopReconciliation();
  };
}

if (process.argv[1]?.endsWith("worker/index.ts") || process.argv[1]?.endsWith("worker/index.js")) {
  startWorker().catch((error) => {
    log.fatal({ error: safeErrorMessage(error) }, "worker failed to start");
    process.exitCode = 1;
  });
}
