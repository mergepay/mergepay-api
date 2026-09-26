import pino from "pino";
import { prisma } from "../db";
import { config } from "../config";
import { stellar } from "./stellar";
import { audit } from "./audit";
import { Errors } from "../errors";
import { applySettlementTransition } from "./settlement-machine";
import type { CorrelationContext } from "../lib/correlation";
import { loggerWithContext } from "../lib/correlation";
import {
  verifyTransactionMemo,
  verifyPaymentOperation,
  getTransactionPayments,
} from "./horizonService";
import { buildMemo, validateMemoAgainstActiveExpense } from "./memo";
import { dispatchEvent } from "./webhook";

const log = pino({ name: "settlement-reconciliation" });

/** Maximum number of reconciliation retries per settlement. */
export const RECONCILIATION_MAX_RETRIES = 10;

/**
 * The outcomes one Horizon lookup can leave a settlement in. `pending` means
 * Horizon has not seen the transaction yet; `expired` means that absence
 * continued beyond the configured pending-age limit.
 */
export type SettlementReconciliationOutcome = "confirmed" | "failed" | "pending" | "expired";

/**
 * Parameters needed for full settlement verification against Horizon.
 * The `stellarTxHash` is the on-chain transaction to verify; the other
 * fields are what the API expects that transaction to contain.
 */
export interface ReconcilableSettlement {
  id: string;
  groupId?: string;
  stellarTxHash: string | null;
  retryCount: number;
  /** Settlement short code, used to derive the expected memo (MP:<code>). */
  shortCode: string;
  /**
   * Expense this settlement pays off. When present, verification resolves the
   * parsed memo code against this record and refuses to confirm while the
   * expense is missing or fully settled (see `validateMemoAgainstActiveExpense`).
   */
  expenseId?: string | null;
  /** Expected payment amount. */
  amount: string;
  /** Expected asset code (e.g. "XLM", "USDC"). */
  assetCode: string;
  /** Expected asset issuer (null for native XLM). */
  assetIssuer: string | null;
  /** Expected payment destination (the recipient's Stellar public key). */
  destinationPublicKey: string;
  /**
   * Persisted status at read time. Only `needs_review` changes behavior: a
   * row still without a Horizon answer is demoted to `pending_confirmation`
   * so the retry budget governs. Optional — omitting it preserves the
   * pre-needs_review behavior (retryCount-only update on not-found).
   */
  status?: string;
  /** Time the transaction was submitted; used to expire unresolved jobs. */
  pendingSince?: Date | null;
}

/**
 * Reconcile a single `pending_confirmation` settlement against Horizon.
 *
 * Reconciliation is read-only against Horizon: it calls
 * `stellar.getTransaction(hash)` and never `submitPayment`.
 *
 *   Transaction found & successful        → verify memo + payment details
 *                                           → `confirmed`
 *   Transaction found & failed             → `failed`     (terminal)
 *   Transaction not yet visible            → stays `pending_confirmation`,
 *                                             retryCount incremented
 *                                             → `pending`
 *                                             If retries exhausted → `failed`
 *                                             If pending-age limit elapsed → `expired`
 *   Verification failure (mismatch)        → `failed`     (terminal)
 *
 * Returns the observed outcome so the calling worker can aggregate batch
 * counts. Concurrency gating (a lease claim before this runs) is the
 * caller's responsibility — see src/worker/index.ts.
 */
export async function reconcileSingleSettlement(
  settlement: ReconcilableSettlement,
  maxRetries: number = RECONCILIATION_MAX_RETRIES,
  ctx?: CorrelationContext
): Promise<SettlementReconciliationOutcome> {
  const hash = settlement.stellarTxHash;
  if (!hash) return "pending";

  const recLog = loggerWithContext(log, ctx);

  const tx = await stellar.getTransaction(hash);

  if (tx === null) {
    return await handleTransactionNotFound(settlement, hash, maxRetries, recLog);
  }

  if (tx.successful) {
    try {
      // Generate the expected memo through the shared helper rather than a
      // raw template literal: an unusable short code is a verification
      // failure, not a string that silently never matches on-chain.
      const expectedMemo = buildMemo(settlement.shortCode);
      if (!expectedMemo.ok) {
        throw Errors.badRequest(
          "transaction_verification_failed",
          `Memo verification failed: ${expectedMemo.message}`
        );
      }
      await verifyTransactionMemo(hash, expectedMemo.memo);

      // The memo must still resolve to a *live* expense: parse it and check
      // the settlement's expense record exists with shares still outstanding
      // before this worker is allowed to confirm. Settlements created before
      // expense linking have no record to validate against and skip this.
      if (settlement.expenseId) {
        const validation = await validateMemoAgainstActiveExpense(
          expectedMemo.memo,
          {
            expectedCode: settlement.shortCode,
            expenseId: settlement.expenseId,
          }
        );
        if (!validation.ok) {
          throw Errors.badRequest(
            "transaction_verification_failed",
            `Memo verification failed: ${validation.message}`
          );
        }
      }

      const payments = await getTransactionPayments(hash);
      const paymentOp = payments.find((op) => op.type === "payment");
      if (!paymentOp) {
        throw Errors.badRequest(
          "settlement_verification_failed",
          "No payment operation found in transaction"
        );
      }
      verifyPaymentOperation(paymentOp, {
        destination: settlement.destinationPublicKey,
        amount: settlement.amount,
        assetCode: settlement.assetCode,
        assetIssuer: settlement.assetIssuer,
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes("verification_failed") ||
          err.message.includes("Memo verification failed") ||
          err.message.includes("does not match") ||
          err.message.includes("No payment operation") ||
          err.message.includes("Horizon request failed"))
      ) {
        await applySettlementTransition({
          settlementId: settlement.id,
          nextStatus: "failed",
          source: "worker",
          extraData: {
            failureReason: err.message,
            retryCount: settlement.retryCount,
          },
        });
        await audit({
          userId: null,
          action: "settlement.verification_failed",
          entityType: "settlement",
          entityId: settlement.id,
          metadata: { stellarTxHash: hash, reason: err.message },
        });
        void dispatchEvent("settlement.failed", { settlementId: settlement.id, reason: err.message }, settlement.groupId)
          .catch(() => undefined);
        recLog.error(
          { id: settlement.id, hash, reason: err.message },
          "settlement transaction verification failed"
        );
        return "failed";
      }
      throw err;
    }

    await applySettlementTransition({
      settlementId: settlement.id,
      nextStatus: "confirmed",
      source: "worker",
      extraData: {
        retryCount: 0,
        failureReason: null,
      },
      settleExpenseShare: true,
    });
    await audit({
      userId: null,
      action: "settlement.completed",
      entityType: "settlement",
      entityId: settlement.id,
      metadata: { stellarTxHash: hash },
    });
    void dispatchEvent("settlement.confirmed", { settlementId: settlement.id, stellarTxHash: hash }, settlement.groupId)
      .catch(() => undefined);
    recLog.info({ id: settlement.id, hash }, "settlement completed");
    return "confirmed";
  }

  await applySettlementTransition({
    settlementId: settlement.id,
    nextStatus: "failed",
    source: "worker",
    extraData: {
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
  void dispatchEvent("settlement.failed", { settlementId: settlement.id, reason: "transaction_failed" }, settlement.groupId)
    .catch(() => undefined);
  recLog.error({ id: settlement.id, hash }, "settlement transaction failed on Stellar");
  return "failed";
}

async function handleTransactionNotFound(
  settlement: { id: string; retryCount: number; status?: string; pendingSince?: Date | null },
  hash: string,
  maxRetries: number,
  recLog: ReturnType<typeof loggerWithContext>
): Promise<SettlementReconciliationOutcome> {
  const nextRetryCount = settlement.retryCount + 1;

  if (
    settlement.pendingSince &&
    Date.now() - settlement.pendingSince.getTime() >= config.WORKER_PENDING_SETTLEMENT_MAX_AGE_MS
  ) {
    await applySettlementTransition({
      settlementId: settlement.id,
      nextStatus: "expired",
      source: "worker",
      extraData: {
        failureReason: `Transaction ${hash} was not found on Stellar before the pending limit expired`,
        retryCount: nextRetryCount,
      },
    });
    recLog.info(
      { id: settlement.id, hash, pendingSince: settlement.pendingSince },
      "settlement expired after remaining unconfirmed beyond the pending limit"
    );
    return "expired";
  }

  if (nextRetryCount > maxRetries) {
    await applySettlementTransition({
      settlementId: settlement.id,
      nextStatus: "failed",
      source: "worker",
      extraData: {
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
    return "failed";
  }

  await prisma.settlement.update({
    where: { id: settlement.id },
    data: {
      retryCount: nextRetryCount,
      // A needs_review row still without a Horizon answer is demoted to
      // pending_confirmation, so the bounded retry budget above — not an
      // unbounded needs_review wait — decides when enough silence is enough.
      // A conditional updateMany is deliberately not needed here: the caller
      // holds the row's lease, which already excludes concurrent writers.
      ...(settlement.status === "needs_review" ? { status: "pending_confirmation" } : {}),
    },
  });
  recLog.debug(
    { id: settlement.id, hash, attempt: nextRetryCount, maxRetries },
    "transaction not yet visible on Horizon, will retry"
  );
  return "pending";
}
