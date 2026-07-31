import pino from "pino";
import { prisma } from "../db";
import { stellar } from "./stellar";
import { audit } from "./audit";
import type { CorrelationContext } from "../lib/correlation";
import { jobContext, loggerWithContext } from "../lib/correlation";

const log = pino({ name: "settlement-reconciliation" });

/** Maximum number of reconciliation retries per settlement. */
export const RECONCILIATION_MAX_RETRIES = 10;

/** Batch size for each reconciliation cycle. */
const BATCH_SIZE = 50;

const reconciling = new Set<string>();

/**
 * Run one reconciliation cycle for all settlements in `pending_confirmation`
 * state — i.e. settlements that were successfully submitted to Horizon but
 * whose Stellar outcome has not yet been confirmed.
 *
 * Reconciliation is read-only against Horizon: it calls
 * `stellar.getTransaction(hash)` and never `submitPayment`.
 *
 *   Transaction found & successful        → `completed`  (terminal)
 *   Transaction found & failed             → `failed`     (terminal)
 *   Transaction not yet visible            → stays `pending_confirmation`,
 *                                             retryCount incremented.
 *                                             If retries exhausted → `failed`
 */
export async function reconcileSettlements(
  maxRetries: number = RECONCILIATION_MAX_RETRIES,
  ctx?: CorrelationContext
): Promise<void> {
  const settlements = await prisma.settlement.findMany({
    where: {
      status: "pending_confirmation",
      stellarTxHash: { not: null },
    },
    take: BATCH_SIZE,
  });

  for (const row of settlements) {
    if (reconciling.has(row.id)) continue;
    reconciling.add(row.id);

    const recCtx = ctx ?? jobContext("reconciliation", row.id);
    const recLog = loggerWithContext(log, recCtx);

    try {
      await reconcileSingleSettlement(row, maxRetries, recCtx);
    } catch (err) {
      recLog.error(
        { id: row.id, hash: row.stellarTxHash, err: err instanceof Error ? err.message : String(err) },
        "unexpected reconciliation error"
      );
    } finally {
      reconciling.delete(row.id);
    }
  }
}

/**
 * Reconcile a single `pending_confirmation` settlement against Horizon.
 *
 * Exported for testing. Callers should handle concurrency gating and
 * error logging.
 */
export async function reconcileSingleSettlement(
  settlement: {
    id: string;
    stellarTxHash: string | null;
    retryCount: number;
  },
  maxRetries: number = RECONCILIATION_MAX_RETRIES,
  ctx?: CorrelationContext
): Promise<void> {
  const hash = settlement.stellarTxHash;
  if (!hash) return;

  const recLog = loggerWithContext(log, ctx);

  const tx = await stellar.getTransaction(hash);

  if (tx === null) {
    await handleTransactionNotFound(settlement, hash, maxRetries, recLog);
    return;
  }

  if (tx.successful) {
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: "completed",
        retryCount: 0,
        failureReason: null,
      },
    });
    await audit({
      userId: null,
      action: "settlement.completed",
      entityType: "settlement",
      entityId: settlement.id,
      metadata: { stellarTxHash: hash },
    });
    recLog.info({ id: settlement.id, hash }, "settlement completed");
  } else {
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: "failed",
        failureReason: `Transaction ${hash} failed on Stellar`,
        retryCount: settlement.retryCount,
      },
    });
    await audit({
      userId: null,
      action: "settlement.failed",
      entityType: "settlement",
      entityId: settlement.id,
      metadata: { stellarTxHash: hash, reason: "transaction_failed" },
    });
    recLog.error({ id: settlement.id, hash }, "settlement transaction failed on Stellar");
  }
}

async function handleTransactionNotFound(
  settlement: { id: string; retryCount: number },
  hash: string,
  maxRetries: number,
  recLog: ReturnType<typeof loggerWithContext>
): Promise<void> {
  const nextRetryCount = settlement.retryCount + 1;

  if (nextRetryCount > maxRetries) {
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: "failed",
        failureReason: `Transaction ${hash} not confirmed after ${maxRetries} reconciliation attempts`,
        retryCount: nextRetryCount,
      },
    });
    await audit({
      userId: null,
      action: "settlement.reconciliation.exhausted",
      entityType: "settlement",
      entityId: settlement.id,
      metadata: {
        stellarTxHash: hash,
        attempts: nextRetryCount,
        maxRetries,
      },
    });
    recLog.error(
      { id: settlement.id, hash, attempts: nextRetryCount, maxRetries },
      "settlement reconciliation exhausted"
    );
  } else {
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: { retryCount: nextRetryCount },
    });
    recLog.debug(
      { id: settlement.id, hash, attempt: nextRetryCount, maxRetries },
      "transaction not yet visible on Horizon, will retry"
    );
  }
}
