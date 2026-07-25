import pino from "pino";
import { config } from "../config";
import { prisma } from "../db";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import { anchorService, mapAnchorStatus } from "../services/anchor";
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

const SETTLEMENT_MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

// ---------------------------------------------------------------------------
// Existing tasks
// ---------------------------------------------------------------------------

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
  } catch {
    return;
  }

  for (const session of sessions) {
    try {
      const status = await anchorService.getTransactionStatus({
        transferServer: toml.transferServerSep24,
        token: session.anchorToken!,
        id: session.externalTransactionId!,
      });

      if (status) {
        await prisma.anchorSession.update({
          where: { id: session.id },
          data: { status: mapAnchorStatus(status) },
        });
      }
    } catch {
      // Retry this session during the next cycle.
    }
  }
}

export async function expireInvites(): Promise<void> {
  await prisma.invite.deleteMany({
    where: { expiresAt: { not: null, lt: new Date() } },
  });
}

// ---------------------------------------------------------------------------
// Settlement submission worker
// ---------------------------------------------------------------------------

class PermanentSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentSettlementError";
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to submit one settlement's signed XDR to the Stellar network.
 * Returns the submitted transaction hash on success, or throws on failure.
 * Transient errors are retryable; permanent errors (including exhausted
 * retries) throw PermanentSettlementError.
 */
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
  } catch (error: any) {
    const msg = error?.message ?? String(error);
    const isTransient =
      msg.includes("timeout") ||
      msg.includes("timed out") ||
      msg.includes("rate_limit") ||
      msg.includes("stale") ||
      msg.includes("connection") ||
      msg.includes("retry");

    if (isTransient && retryAttempt < SETTLEMENT_MAX_RETRIES) {
      log.warn(
        { id: settlement.id, attempt: retryAttempt, err: msg },
        "transient error submitting settlement; will retry"
      );
      throw error;
    }

    log.error(
      { id: settlement.id, attempt: retryAttempt, err: msg },
      "settlement submission failed permanently"
    );
    throw new PermanentSettlementError(msg);
  }
}

export async function processSubmittedSettlements(): Promise<void> {
  const settlements = await prisma.settlement.findMany({
    where: {
      status: { in: ["pending", "submitted"] },
      transactionXdr: { not: null },
    },
    include: { from: true, to: true },
    take: 50,
    orderBy: { createdAt: "asc" },
  });

  if (settlements.length === 0) return;

  log.info({ count: settlements.length }, "processing submitted settlements");

  for (const settlement of settlements) {
    try {
      let hash: string | undefined;
      let attempt = 0;

      while (attempt <= SETTLEMENT_MAX_RETRIES) {
        if (attempt > 0) {
          const delay = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];
          log.info(
            { id: settlement.id, attempt, delay },
            "retrying settlement submission"
          );
          await sleep(delay);
        }

        try {
          hash = await submitSettlement(
            {
              id: settlement.id,
              shortCode: settlement.shortCode,
              fromPublicKey: settlement.from.stellarPublicKey,
              toPublicKey: settlement.to.stellarPublicKey,
              amount: settlement.amount.toString(),
              assetCode: settlement.assetCode,
              assetIssuer: settlement.assetIssuer,
              transactionXdr: settlement.transactionXdr,
              expenseShareId: settlement.expenseShareId,
              retryCount: settlement.retryCount,
              status: settlement.status,
              createdAt: settlement.createdAt,
            },
            attempt
          );
          break;
        } catch (error: any) {
          if (error instanceof PermanentSettlementError || attempt >= SETTLEMENT_MAX_RETRIES) {
            throw error;
          }
          attempt++;
        }
      }

      if (hash) {
        await prisma.$transaction(async (tx) => {
          const updated = await tx.settlement.update({
            where: { id: settlement.id },
            data: { status: "confirmed", stellarTxHash: hash },
          });
          if (settlement.expenseShareId) {
            await tx.expenseShare.update({
              where: { id: settlement.expenseShareId },
              data: { status: "settled" },
            });
          }
          return updated;
        });

        log.info({ id: settlement.id, hash }, "settlement confirmed");

        await audit({
          action: "settlement.confirmed",
          entityType: "settlement",
          entityId: settlement.id,
          metadata: { status: "confirmed", stellarTxHash: hash },
        });
      }
    } catch (error: any) {
      const msg = error?.message ?? String(error);

      await prisma.settlement.update({
        where: { id: settlement.id },
        data: {
          status: "failed",
          failureReason: msg,
          retryCount: { increment: 1 },
        },
      });

      log.error(
        { id: settlement.id, err: msg },
        "settlement marked as failed after exhausting retries"
      );

      await audit({
        action: "settlement.failed",
        entityType: "settlement",
        entityId: settlement.id,
        metadata: { failureReason: msg },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Worker lifecycle
// ---------------------------------------------------------------------------

export function startWorker(opts?: {
  fastMs?: number;
  slowMs?: number;
}): () => void {
  const slowMs = opts?.slowMs ?? 60_000;
  const settlementMs = config.WORKER_INTERVAL_MS;

  const stopReconciliation = opts?.fastMs
    ? startReconciliation({ intervalMs: opts.fastMs })
    : startReconciliation();

  const slow = setInterval(() => {
    reconcileAnchors().catch((error) => log.error({ err: error }, "reconcileAnchors error"));
    expireInvites().catch((error) => log.error({ err: error }, "expireInvites error"));
  }, slowMs);

  const settlementWorker = setInterval(() => {
    processSubmittedSettlements().catch((error) =>
      log.error({ err: error }, "processSubmittedSettlements error")
    );
  }, settlementMs);

  log.info(
    {
      reconciliation: opts?.fastMs ?? "configured",
      slow: slowMs,
      settlement: settlementMs,
    },
    "worker started"
  );

  return () => {
    stopReconciliation();
    clearInterval(slow);
    clearInterval(settlementWorker);
  };
}

if (require.main === module) {
  const stop = startWorker();
  const shutdown = async () => {
    log.info("shutting down");
    stop();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
