import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    expenseShare: {
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    statusHistory: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getTransaction: vi.fn(),
    verifyTransactionMemo: vi.fn(),
    getTransactionPayments: vi.fn(),
    verifyPaymentOperation: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: {
    getTransaction: h.getTransaction,
  },
}));
vi.mock("../src/services/audit", () => ({
  audit: h.audit,
  auditTx: vi.fn(),
}));
vi.mock("../src/services/horizonService", () => ({
  verifyTransactionMemo: h.verifyTransactionMemo,
  getTransactionPayments: h.getTransactionPayments,
  verifyPaymentOperation: h.verifyPaymentOperation,
}));

import {
  reconcileSettlements,
  reconcileSingleSettlement,
  type ReconcilableSettlement,
} from "../src/services/settlement-reconciliation";

function pendingConfirmationSettlement(over: Record<string, any> = {}) {
  return {
    id: "settle_1",
    shortCode: "ABC123",
    groupId: "group_1",
    fromUserId: "user_1",
    toUserId: "user_2",
    amount: "12.5000000",
    assetCode: "XLM",
    assetIssuer: null,
    transactionXdr: "AAAA...",
    stellarTxHash: "abc123def456",
    status: "pending_confirmation",
    retryCount: 0,
    failureReason: null,
    memo: "MP:ABC123",
    expenseId: null,
    expenseShareId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    from: { stellarPublicKey: "GFROM..." },
    to: { stellarPublicKey: "GTO..." },
    ...over,
  };
}

/** Build the reconcilable settlement params used by reconcileSingleSettlement. */
function makeReconcilable(over: Partial<ReconcilableSettlement> = {}): ReconcilableSettlement {
  return {
    id: "settle_1",
    stellarTxHash: "abc123def456",
    retryCount: 0,
    shortCode: "ABC123",
    amount: "12.5000000",
    assetCode: "XLM",
    assetIssuer: null,
    destinationPublicKey: "GTO...",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.settlement.findMany.mockResolvedValue([]);
  h.prisma.settlement.update.mockResolvedValue({});
  h.prisma.settlement.findUnique.mockResolvedValue({
    id: "settle_1",
    status: "pending_confirmation",
    fromUserId: "user_1",
    expenseShareId: null,
    retryCount: 0,
  });
  h.getTransactionPayments.mockResolvedValue([
    { type: "payment", destination: "GTO...", amount: "12.5000000", asset_type: "native" },
  ]);
  h.verifyTransactionMemo.mockResolvedValue({ verified: true });
  h.verifyPaymentOperation.mockImplementation(() => {});
});

describe("reconcileSettlements", () => {
  it("processes a batch of pending_confirmation settlements", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      pendingConfirmationSettlement({ id: "s1", stellarTxHash: "hash1" }),
      pendingConfirmationSettlement({ id: "s2", stellarTxHash: "hash2" }),
    ]);
    h.getTransaction.mockResolvedValue({ successful: true });

    await reconcileSettlements(10);

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledTimes(2);
    expect(h.getTransaction).toHaveBeenCalledTimes(2);
    expect(h.getTransaction).toHaveBeenCalledWith("hash1");
    expect(h.getTransaction).toHaveBeenCalledWith("hash2");
    expect(h.verifyTransactionMemo).toHaveBeenCalledTimes(2);
  });

  it("does not call getTransaction when there are no pending_confirmation settlements", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([]);

    await reconcileSettlements();

    expect(h.getTransaction).not.toHaveBeenCalled();
    expect(h.prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("handles errors for individual settlements without stopping the batch", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      pendingConfirmationSettlement({ id: "s1", stellarTxHash: "hash1" }),
      pendingConfirmationSettlement({ id: "s2", stellarTxHash: "hash2" }),
    ]);
    h.getTransaction
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({ successful: true });

    await reconcileSettlements(10);

    // s2 should still be processed despite s1's error
    expect(h.getTransaction).toHaveBeenCalledTimes(2);
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledTimes(1);
  });

  it("does not call getTransaction for a settlement that has no stellarTxHash", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      pendingConfirmationSettlement({ id: "s1", stellarTxHash: null }),
    ]);

    await reconcileSettlements(10);

    expect(h.getTransaction).not.toHaveBeenCalled();
  });

  it("only queries settlements in pending_confirmation status", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([]);

    await reconcileSettlements();

    expect(h.prisma.settlement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { status: "pending_confirmation", stellarTxHash: { not: null } },
      })
    );
  });
});

describe("reconcileSingleSettlement", () => {
  it("moves to completed when transaction is found, successful, and verified", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "confirmed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_abc", retryCount: 0, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "confirmed",
          retryCount: 0,
          failureReason: null,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.completed",
        entityId: "settle_1",
        metadata: expect.objectContaining({ stellarTxHash: "hash_abc" }),
      })
    );
  });

  it("moves to failed when transaction is found but was not successful", async () => {
    h.getTransaction.mockResolvedValue({ successful: false });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 2,
    });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_fail", retryCount: 2, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("hash_fail"),
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.failed",
      })
    );
  });

  it("increments retryCount when transaction is not yet visible", async () => {
    h.getTransaction.mockResolvedValue(null);

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_pending", retryCount: 0, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: { retryCount: 1 },
      })
    );
    // Audit not called — just a retry, not a terminal state
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("fails the settlement when retries are exhausted and tx not visible", async () => {
    h.getTransaction.mockResolvedValue(null);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 10,
    });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_stale", retryCount: 10, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("not confirmed"),
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.reconciliation.exhausted",
        metadata: expect.objectContaining({
          attempts: 11,
          maxRetries: 10,
        }),
      })
    );
  });

  it("is a no-op when there is no stellarTxHash", async () => {
    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: null, retryCount: 0, expenseShareId: null },
      10
    );

    expect(h.getTransaction).not.toHaveBeenCalled();
    expect(h.prisma.settlement.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("is idempotent — repeated calls for a settled tx return the same result", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "confirmed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });

    await reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_abc" }), 10);
    await reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_abc" }), 10);

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Verification failure tests
// ---------------------------------------------------------------------------

describe("reconcileSingleSettlement — verification failures", () => {
  it("fails the settlement when memo verification fails", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockRejectedValue(
      new Error("Transaction memo does not match the expected settlement reference")
    );
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_abc" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        metadata: expect.objectContaining({
          reason: expect.stringContaining("memo"),
        }),
      })
    );
  });

  it("fails the settlement when destination verification fails", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockResolvedValue({ verified: true });
    h.getTransactionPayments.mockResolvedValue([
      { type: "payment", destination: "GWRONG...", amount: "12.5000000", asset_type: "native" },
    ]);
    h.verifyPaymentOperation.mockImplementation(() => {
      throw new Error("Payment destination does not match the expected recipient");
    });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_abc" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  it("fails the settlement when getTransactionPayments throws", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockResolvedValue({ verified: true });
    h.getTransactionPayments.mockRejectedValue(
      new Error("Horizon request failed: connection timeout")
    );
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_payments_error" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("Horizon"),
        }),
      })
    );
  });
});
