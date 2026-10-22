import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const tx = {
    expenseShare: { update: vi.fn(async () => ({})) },
  };
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (client: any) => Promise<unknown>) => fn(tx)),
  };
  return {
    prisma,
    tx,
    getTransaction: vi.fn(),
    applySettlementTransition: vi.fn(async () => ({ settlement: {}, changed: true })),
    recordStatusTransitionInTransaction: vi.fn(async () => ({})),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { getTransaction: h.getTransaction },
}));
vi.mock("../src/services/settlement-machine", () => ({
  applySettlementTransition: h.applySettlementTransition,
}));
vi.mock("../src/services/status-history", () => ({
  recordStatusTransitionInTransaction: h.recordStatusTransitionInTransaction,
}));

import { reconcilePendingSettlementStatuses } from "../src/worker/tasks/settlement-status-reconciliation";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const opts = {
  workerId: "worker-a",
  now: () => NOW,
  recheckDelayMs: 60_000,
  expiryGraceMs: 300_000,
  leaseMs: 30_000,
};

const row = (over: Record<string, unknown> = {}) => ({
  id: "settle_1",
  stellarTxHash: "hash_1",
  expenseShareId: "share_1",
  expiresAt: new Date(NOW.getTime() + 60_000),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
});

describe("reconcilePendingSettlementStatuses", () => {
  it("only selects due, unleased needs_review settlements with a hash", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([]);

    await reconcilePendingSettlementStatuses({ ...opts, batchSize: 7 });

    const args = h.prisma.settlement.findMany.mock.calls[0][0];
    expect(args.where.status).toBe("needs_review");
    expect(args.where.stellarTxHash).toEqual({ not: null });
    expect(args.where.AND).toEqual([
      { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: NOW } }] },
      { OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: NOW } }] },
    ]);
    expect(args.take).toBe(7);
    expect(h.getTransaction).not.toHaveBeenCalled();
  });

  it("confirms a successful transaction and settles its share atomically", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row()]);
    h.getTransaction.mockResolvedValue({ successful: true });

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "confirmed" });
    expect(h.getTransaction).toHaveBeenCalledWith("hash_1");
    expect(h.prisma.$transaction).toHaveBeenCalledOnce();
    expect(h.applySettlementTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementId: "settle_1",
        nextStatus: "confirmed",
        source: "worker",
        tx: h.tx,
        extraData: expect.objectContaining({ claimedBy: null, failureReason: null }),
      })
    );
    expect(h.recordStatusTransitionInTransaction).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ entityId: "settle_1", newStatus: "confirmed" })
    );
    expect(h.tx.expenseShare.update).toHaveBeenCalledWith({
      where: { id: "share_1" },
      data: { status: "settled" },
    });
  });

  it("fails a settlement whose transaction failed on Stellar, leaving the share alone", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row()]);
    h.getTransaction.mockResolvedValue({ successful: false });

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "failed" });
    expect(h.applySettlementTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: "failed",
        extraData: expect.objectContaining({
          errorCategory: "permanent",
          failureReason: "Transaction hash_1 failed on Stellar",
        }),
      })
    );
    expect(h.tx.expenseShare.update).not.toHaveBeenCalled();
  });

  it("keeps waiting while the envelope can still land", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row()]);
    h.getTransaction.mockResolvedValue(null);

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "pending" });
    expect(h.applySettlementTransition).not.toHaveBeenCalled();
    expect(h.prisma.settlement.updateMany).toHaveBeenLastCalledWith({
      where: { id: "settle_1", claimedBy: "worker-a" },
      data: expect.objectContaining({
        claimedBy: null,
        leaseExpiresAt: null,
        nextAttemptAt: new Date(NOW.getTime() + 60_000),
      }),
    });
  });

  it("keeps waiting within the grace period after expiry", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      row({ expiresAt: new Date(NOW.getTime() - 299_000) }),
    ]);
    h.getTransaction.mockResolvedValue(null);

    expect(await reconcilePendingSettlementStatuses(opts)).toEqual({ settle_1: "pending" });
  });

  it("fails a settlement that never landed once its time bounds and grace have passed", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([
      row({ expiresAt: new Date(NOW.getTime() - 301_000) }),
    ]);
    h.getTransaction.mockResolvedValue(null);

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "failed" });
    expect(h.applySettlementTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        nextStatus: "failed",
        extraData: expect.objectContaining({
          failureReason: expect.stringContaining("never appeared on Stellar"),
        }),
      })
    );
  });

  it("never fails a missing transaction that has no recorded expiry", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row({ expiresAt: null })]);
    h.getTransaction.mockResolvedValue(null);

    expect(await reconcilePendingSettlementStatuses(opts)).toEqual({ settle_1: "pending" });
    expect(h.applySettlementTransition).not.toHaveBeenCalled();
  });

  it("treats a Horizon error as no information and re-checks later", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row()]);
    h.getTransaction.mockRejectedValue(new Error("Horizon unavailable"));

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "error" });
    expect(h.applySettlementTransition).not.toHaveBeenCalled();
    expect(h.prisma.settlement.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextAttemptAt: new Date(NOW.getTime() + 60_000) }),
      })
    );
  });

  it("skips a settlement another worker already claimed", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row()]);
    h.prisma.settlement.updateMany.mockResolvedValueOnce({ count: 0 });

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "skipped" });
    expect(h.getTransaction).not.toHaveBeenCalled();
  });

  it("claims with a lease guard so two workers cannot both process a row", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row()]);
    h.getTransaction.mockResolvedValue(null);

    await reconcilePendingSettlementStatuses(opts);

    const claim = h.prisma.settlement.updateMany.mock.calls[0][0];
    expect(claim.where).toMatchObject({ id: "settle_1", status: "needs_review" });
    expect(claim.data).toEqual({
      claimedBy: "worker-a",
      claimedAt: NOW,
      leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    });
  });

  it("releases the lease and continues the batch when a write fails", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([row(), row({ id: "settle_2", stellarTxHash: "hash_2" })]);
    h.getTransaction.mockResolvedValue({ successful: true });
    h.applySettlementTransition.mockRejectedValueOnce(new Error("db down"));

    const outcomes = await reconcilePendingSettlementStatuses(opts);

    expect(outcomes).toEqual({ settle_1: "error", settle_2: "confirmed" });
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith({
      where: { id: "settle_1", claimedBy: "worker-a" },
      data: { claimedBy: null, claimedAt: null, leaseExpiresAt: null },
    });
  });
});
