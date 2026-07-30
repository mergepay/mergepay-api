import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getTransaction: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: {
    getTransaction: h.getTransaction,
  },
}));
vi.mock("../src/services/audit", () => ({ audit: h.audit }));

import {
  reconcileSettlements,
  reconcileSingleSettlement,
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

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.settlement.findMany.mockResolvedValue([]);
  h.prisma.settlement.update.mockResolvedValue({});
});

describe("reconcileSettlements", () => {
  it("processes a batch of pending_confirmation settlements", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      pendingConfirmationSettlement({ id: "s1", stellarTxHash: "hash1" }),
      pendingConfirmationSettlement({ id: "s2", stellarTxHash: "hash2" }),
    ]);
    h.getTransaction.mockResolvedValue({ successful: true });

    await reconcileSettlements(10);

    expect(h.prisma.settlement.update).toHaveBeenCalledTimes(2);
    expect(h.getTransaction).toHaveBeenCalledTimes(2);
    expect(h.getTransaction).toHaveBeenCalledWith("hash1");
    expect(h.getTransaction).toHaveBeenCalledWith("hash2");
  });

  it("does not call getTransaction when there are no pending_confirmation settlements", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([]);

    await reconcileSettlements();

    expect(h.getTransaction).not.toHaveBeenCalled();
    expect(h.prisma.settlement.update).not.toHaveBeenCalled();
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
    expect(h.prisma.settlement.update).toHaveBeenCalledTimes(1);
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
  it("moves to completed when transaction is found and successful", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_abc", retryCount: 0 },
      10
    );

    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: expect.objectContaining({
          status: "completed",
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

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_fail", retryCount: 2 },
      10
    );

    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
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
      { id: "settle_1", stellarTxHash: "hash_pending", retryCount: 0 },
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

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_stale", retryCount: 10 },
      10
    );

    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
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
      { id: "settle_1", stellarTxHash: null, retryCount: 0 },
      10
    );

    expect(h.getTransaction).not.toHaveBeenCalled();
    expect(h.prisma.settlement.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("is idempotent — repeated calls for a settled tx return the same result", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_abc", retryCount: 0 },
      10
    );
    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_abc", retryCount: 0 },
      10
    );

    expect(h.prisma.settlement.update).toHaveBeenCalledTimes(2);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "completed" }),
      })
    );
  });
});
