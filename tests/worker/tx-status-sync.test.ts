/**
 * The status-sync worker job (issue #355): pending transactions the database
 * still owes an on-chain answer are checked against Horizon and written back.
 *
 * Horizon is always mocked — these tests run offline like the rest of the
 * suite — and Pino is captured so the progress contract (one line per state
 * change, one `batch_synced` summary per cycle) is pinned alongside the
 * database writes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AuditAction } from "../../src/services/audit-actions";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    treasuryTransaction: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return {
    prisma,
    getTransaction: vi.fn(),
    verifyTransactionMemo: vi.fn(),
    getTransactionPayments: vi.fn(),
    verifyPaymentOperation: vi.fn(),
    reconcileSingleSettlement: vi.fn(),
    audit: vi.fn(),
    logger: (() => {
      const logger: any = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      logger.child = vi.fn(() => logger);
      return logger;
    })(),
  };
});

vi.mock("pino", () => ({ default: vi.fn(() => h.logger) }));
vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/stellar", () => ({
  stellar: { getTransaction: h.getTransaction },
}));
vi.mock("../../src/services/horizonService", () => ({
  verifyTransactionMemo: h.verifyTransactionMemo,
  getTransactionPayments: h.getTransactionPayments,
  verifyPaymentOperation: h.verifyPaymentOperation,
}));
vi.mock("../../src/services/settlement-reconciliation", () => ({
  RECONCILIATION_MAX_RETRIES: 10,
  reconcileSingleSettlement: h.reconcileSingleSettlement,
}));
vi.mock("../../src/services/audit", () => ({ audit: h.audit }));

import { AppError } from "../../src/errors";
import {
  STATUS_SYNC_EXPIRED_GRACE_MS,
  STATUS_SYNC_MIN_AGE_MS,
  TX_STATUS_SYNC_JOB,
  syncPendingTransactionStatuses,
} from "../../src/worker/tasks/tx-status-sync";

const NOW = new Date("2026-06-01T00:10:00.000Z");
const CUTOFF = new Date(NOW.getTime() - STATUS_SYNC_MIN_AGE_MS);
const NO_DELAY = async (): Promise<void> => {};

const deps = { delay: NO_DELAY };

const settlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  groupId: "group_1",
  shortCode: "SETL1234",
  stellarTxHash: "hash_settle",
  retryCount: 1,
  amount: "10.00",
  assetCode: "USDC",
  assetIssuer: "GISSUER",
  expenseId: "exp_1",
  status: "verifying",
  updatedAt: new Date(NOW.getTime() - 5 * 60_000),
  to: { stellarPublicKey: "GDEST" },
  ...over,
});

const treasury = (over: Record<string, any> = {}) => ({
  id: "ttx_1",
  groupId: "group_1",
  userId: "user_1",
  direction: "deposit",
  amount: "25.5",
  assetCode: "USDC",
  assetIssuer: "GISSUER",
  destination: "GTREASURY",
  stellarTxHash: null,
  intendedTxHash: "hash_ttx",
  status: "pending",
  memo: "MP:AB12CD3456",
  expiresAt: new Date(NOW.getTime() + 60 * 60_000),
  createdAt: new Date(NOW.getTime() - 5 * 60_000),
  ...over,
});

const paymentOp = {
  type: "payment",
  destination: "GTREASURY",
  amount: "25.5000000",
  asset_type: "credit_alphanum4",
  asset_code: "USDC",
  asset_issuer: "GISSUER",
};

/** Calls that released a settlement lease (data clears `claimedBy`). */
function leaseReleases(): any[] {
  return h.prisma.settlement.updateMany.mock.calls.filter(
    ([arg]: any[]) => arg?.data?.claimedBy === null
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.settlement.findMany.mockResolvedValue([]);
  h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.treasuryTransaction.findMany.mockResolvedValue([]);
  h.prisma.treasuryTransaction.updateMany.mockResolvedValue({ count: 1 });
  h.getTransaction.mockResolvedValue(null);
  h.verifyTransactionMemo.mockResolvedValue({ verified: true });
  h.getTransactionPayments.mockResolvedValue([]);
  h.verifyPaymentOperation.mockReturnValue(undefined);
  h.reconcileSingleSettlement.mockResolvedValue("pending");
  h.audit.mockResolvedValue(undefined);
});

describe("syncPendingTransactionStatuses", () => {
  it("reports an empty cycle and still logs the batch summary", async () => {
    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(summary).toEqual({
      checked: 0,
      confirmed: 0,
      failed: 0,
      pending: 0,
      unavailable: 0,
      skipped: 0,
    });
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: TX_STATUS_SYNC_JOB,
        outcome: "batch_synced",
        checked: 0,
      }),
      "pending Stellar transaction statuses synced"
    );
  });

  it("tallies both slices into one logged summary", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([settlement()]);
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockResolvedValue({ successful: true });
    h.getTransactionPayments.mockResolvedValue([paymentOp]);
    h.reconcileSingleSettlement.mockResolvedValue("confirmed");

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(summary).toEqual({
      checked: 2,
      confirmed: 2,
      failed: 0,
      pending: 0,
      unavailable: 0,
      skipped: 0,
    });
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: TX_STATUS_SYNC_JOB,
        outcome: "batch_synced",
        checked: 2,
        confirmed: 2,
        failed: 0,
        pending: 0,
        unavailable: 0,
        skipped: 0,
      }),
      "pending Stellar transaction statuses synced"
    );
  });
});

describe("settlement status sync", () => {
  it("only loads stale verifying settlements that hold a hash and no live lease", async () => {
    await syncPendingTransactionStatuses(NOW, deps);

    expect(h.prisma.settlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["verifying"] },
          stellarTxHash: { not: null },
          updatedAt: { lt: CUTOFF },
          AND: [
            {
              OR: [
                { leaseExpiresAt: null },
                { leaseExpiresAt: { lte: NOW } },
              ],
            },
          ],
        },
        take: expect.any(Number),
      })
    );
  });

  it("claims the row, checks it through the shared reconciliation, and releases the lease", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([settlement()]);
    h.reconcileSingleSettlement.mockResolvedValue("confirmed");

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "settle_1",
          status: { in: ["verifying"] },
          stellarTxHash: "hash_settle",
        }),
        data: expect.objectContaining({
          claimedBy: expect.any(String),
          claimedAt: NOW,
          leaseExpiresAt: expect.any(Date),
        }),
      })
    );
    expect(h.reconcileSingleSettlement).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "settle_1",
        groupId: "group_1",
        stellarTxHash: "hash_settle",
        retryCount: 1,
        shortCode: "SETL1234",
        expenseId: "exp_1",
        amount: "10.00",
        assetCode: "USDC",
        assetIssuer: "GISSUER",
        destinationPublicKey: "GDEST",
        status: "verifying",
      }),
      10,
      expect.objectContaining({ jobId: "settle_1" })
    );
    expect(leaseReleases()).toHaveLength(1);
    expect(summary).toEqual({
      checked: 1,
      confirmed: 1,
      failed: 0,
      pending: 0,
      unavailable: 0,
      skipped: 0,
    });
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: TX_STATUS_SYNC_JOB,
        jobId: "settle_1",
        outcome: "confirmed",
      }),
      "settlement transaction status synced"
    );
  });

  it("never checks a row it could not claim", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([settlement()]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 0 });

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.reconcileSingleSettlement).not.toHaveBeenCalled();
    expect(summary).toEqual({
      checked: 0,
      confirmed: 0,
      failed: 0,
      pending: 0,
      unavailable: 0,
      skipped: 1,
    });
  });

  it("keeps the batch alive when one row blows up, then releases both leases", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      settlement({ id: "settle_1" }),
      settlement({ id: "settle_2" }),
    ]);
    h.reconcileSingleSettlement
      .mockRejectedValueOnce(new Error("Horizon exploded"))
      .mockResolvedValueOnce("confirmed");

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.reconcileSingleSettlement).toHaveBeenCalledTimes(2);
    expect(leaseReleases()).toHaveLength(2);
    expect(summary).toEqual({
      checked: 2,
      confirmed: 1,
      failed: 0,
      pending: 0,
      unavailable: 1,
      skipped: 0,
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: TX_STATUS_SYNC_JOB,
        jobId: "settle_1",
        outcome: "unavailable",
      }),
      "unable to sync settlement transaction status"
    );
  });

  it("skips hashless rows instead of asking Horizon about nothing", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      settlement({ stellarTxHash: null }),
    ]);

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.prisma.settlement.updateMany).not.toHaveBeenCalled();
    expect(h.reconcileSingleSettlement).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.checked).toBe(0);
  });
});

describe("treasury transaction status sync", () => {
  it("only loads live treasury intents older than the sync window", async () => {
    await syncPendingTransactionStatuses(NOW, deps);

    // Live means still valid, or expired within the grace window that keeps
    // a transaction landing just before its deadline observable.
    expect(h.prisma.treasuryTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: ["pending", "awaiting_signatures"] },
          createdAt: { lt: CUTOFF },
          OR: [
            { expiresAt: null },
            {
              expiresAt: {
                gt: new Date(NOW.getTime() - STATUS_SYNC_EXPIRED_GRACE_MS),
              },
            },
          ],
          AND: [
            {
              OR: [
                { stellarTxHash: { not: null } },
                { intendedTxHash: { not: null } },
              ],
            },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: expect.any(Number),
      })
    );
  });

  it("confirms a wallet-submitted intent after memo and payment verification", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockResolvedValue({ successful: true });
    h.getTransactionPayments.mockResolvedValue([paymentOp]);

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    // The lookup runs under the recorded envelope hash — the hash of the
    // signed payment is the same, whoever submitted it.
    expect(h.getTransaction).toHaveBeenCalledWith("hash_ttx");
    expect(h.verifyTransactionMemo).toHaveBeenCalledWith(
      "hash_ttx",
      "MP:AB12CD3456"
    );
    expect(h.verifyPaymentOperation).toHaveBeenCalledWith(paymentOp, {
      destination: "GTREASURY",
      amount: "25.5",
      assetCode: "USDC",
      assetIssuer: "GISSUER",
    });

    // Compare-and-set: only lands while the row is still pending.
    expect(h.prisma.treasuryTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: "ttx_1", status: { in: ["pending", "awaiting_signatures"] } },
      data: { status: "confirmed", stellarTxHash: "hash_ttx" },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.TREASURY_TRANSACTION_CONFIRMED,
        entityType: "treasury_transaction",
        entityId: "ttx_1",
        outcome: "success",
        metadata: expect.objectContaining({ stellarTxHash: "hash_ttx" }),
      })
    );
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: TX_STATUS_SYNC_JOB,
        jobId: "ttx_1",
        table: "treasury_transactions",
        outcome: "confirmed",
      }),
      "treasury transaction confirmed on Stellar"
    );
    expect(summary).toEqual({
      checked: 1,
      confirmed: 1,
      failed: 0,
      pending: 0,
      unavailable: 0,
      skipped: 0,
    });
  });

  it("marks the row failed when the ledger rejected the transaction", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockResolvedValue({ successful: false });

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.verifyTransactionMemo).not.toHaveBeenCalled();
    expect(h.prisma.treasuryTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: "ttx_1", status: { in: ["pending", "awaiting_signatures"] } },
      data: { status: "failed", stellarTxHash: "hash_ttx" },
    });
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.TREASURY_TRANSACTION_FAILED,
        outcome: "failure",
        metadata: expect.objectContaining({
          reason: "Transaction hash_ttx failed on Stellar",
        }),
      })
    );
    expect(summary.failed).toBe(1);
  });

  it("leaves a transaction Horizon has not seen yet untouched", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockResolvedValue(null);

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.prisma.treasuryTransaction.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(summary).toEqual({
      checked: 1,
      confirmed: 0,
      failed: 0,
      pending: 1,
      unavailable: 0,
      skipped: 0,
    });
    expect(h.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "ttx_1", outcome: "pending" }),
      "treasury transaction not yet visible on Stellar"
    );
  });

  it("fails the row when the on-chain transaction does not match the stored intent", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockRejectedValue(
      new AppError(
        400,
        "transaction_verification_failed",
        "Transaction memo does not match the expected settlement reference"
      )
    );

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.prisma.treasuryTransaction.updateMany).toHaveBeenCalledWith({
      where: { id: "ttx_1", status: { in: ["pending", "awaiting_signatures"] } },
      data: { status: "failed", stellarTxHash: "hash_ttx" },
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "ttx_1", outcome: "failed" }),
      "treasury transaction does not match the stored intent"
    );
    expect(summary.failed).toBe(1);
  });

  it("retries Horizon rate limits with backoff, then defers the row without writing", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockRejectedValue(
      Object.assign(new Error("Too Many Requests"), {
        response: { status: 429 },
      })
    );

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    // Three attempts from HORIZON_RETRY_POLICY, then the row waits for the
    // next cycle — a throttled Horizon must not fail or wedge the record.
    expect(h.getTransaction).toHaveBeenCalledTimes(3);
    expect(h.prisma.treasuryTransaction.updateMany).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(summary).toEqual({
      checked: 1,
      confirmed: 0,
      failed: 0,
      pending: 0,
      unavailable: 1,
      skipped: 0,
    });
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: TX_STATUS_SYNC_JOB,
        jobId: "ttx_1",
        outcome: "unavailable",
        attempts: 3,
      }),
      expect.stringContaining("deferred to the next cycle")
    );
  });

  it("does not write when the row changed under the sync", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([treasury()]);
    h.getTransaction.mockResolvedValue({ successful: true });
    h.getTransactionPayments.mockResolvedValue([paymentOp]);
    h.prisma.treasuryTransaction.updateMany.mockResolvedValue({ count: 0 });

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.audit).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
    expect(summary.checked).toBe(1);
  });

  it("keeps syncing the rest of the batch when Horizon never answers for one row", async () => {
    h.prisma.treasuryTransaction.findMany.mockResolvedValue([
      treasury({ id: "ttx_1", intendedTxHash: "hash_slow" }),
      treasury({ id: "ttx_2", intendedTxHash: "hash_ok" }),
    ]);
    // The whole retry budget fails for the first row, then Horizon answers.
    const unavailable = Object.assign(new Error("upstream timeout"), {
      response: { status: 503 },
    });
    h.getTransaction
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValue({ successful: true });
    h.getTransactionPayments.mockResolvedValue([paymentOp]);

    const summary = await syncPendingTransactionStatuses(NOW, deps);

    expect(h.prisma.treasuryTransaction.updateMany).toHaveBeenCalledTimes(1);
    expect(h.prisma.treasuryTransaction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "ttx_2" }),
      })
    );
    expect(summary).toEqual({
      checked: 2,
      confirmed: 1,
      failed: 0,
      pending: 0,
      unavailable: 1,
      skipped: 0,
    });
  });
});
