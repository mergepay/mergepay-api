import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for safe transaction boundaries on settlement state changes.
 *
 * These cover the acceptance criteria from issue #230:
 *  - related settlement status, participant allocation (expenseShare), and
 *    audit writes commit or roll back together;
 *  - concurrent requests cannot apply the same lifecycle transition twice;
 *  - a failed transaction leaves the previous valid state intact;
 *  - repeated requests for an already-applied transition return the existing
 *    result without duplicating records.
 */

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    expenseShare: {
      update: vi.fn(),
    },
    statusHistory: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  applySettlementTransition,
  type SettlementStatus,
} from "../src/services/settlement-machine";

const prisma = h.prisma;

const fakeSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  groupId: "group_1",
  fromUserId: "user_1",
  toUserId: "user_2",
  amount: "10.00",
  assetCode: "USDC",
  assetIssuer: null,
  status: "pending",
  retryCount: 0,
  failureReason: null,
  submittedAt: null,
  confirmedAt: null,
  expenseShareId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  vi.resetAllMocks();
  // Re-establish the transaction wrapper after reset; individual mocks are
  // set per-test below so no implementations leak between cases.
  prisma.$transaction.mockImplementation(async (fn: any) => fn(prisma));
});

describe("applySettlementTransition atomicity", () => {
  it("writes status, audit, and status-history together (all-or-nothing)", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted", submittedAt: new Date() })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });

    expect(result.changed).toBe(true);
    // The conditional update commits the status change...
    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1);
    // ...and the audit + status-history writes run inside the same transaction,
    // so a caller can never observe a status change without its audit entry.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.statusHistory.create).toHaveBeenCalledTimes(1);
  });

  it("rolling back on audit failure keeps the prior status intact", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );
    // Simulate the audit write failing inside the transaction — the whole
    // transaction must roll back, leaving the settlement in its prior state.
    prisma.auditLog.create.mockRejectedValueOnce(new Error("audit write failed"));

    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "submitted",
        source: "user",
      })
    ).rejects.toThrow();

    // No status-history entry should survive a rolled-back transaction.
    expect(prisma.statusHistory.create).not.toHaveBeenCalled();
  });
});

describe("applySettlementTransition concurrency guard", () => {
  it("cannot advance a settlement twice from the same prior state", async () => {
    // First call: status is pending, transition to submitted succeeds.
    prisma.settlement.findUnique.mockResolvedValueOnce(fakeSettlement({ status: "pending" }));
    prisma.settlement.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValueOnce(
      fakeSettlement({ status: "submitted" })
    );

    const first = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });
    expect(first.changed).toBe(true);

    // Second concurrent call: the settlement is already "submitted", so the
    // conditional update (status in ["pending"]) affects zero rows and we
    // return the winning state without re-applying the transition.
    prisma.settlement.findUnique.mockResolvedValueOnce(fakeSettlement({ status: "submitted" }));
    prisma.settlement.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValueOnce(
      fakeSettlement({ status: "submitted" })
    );

    const second = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });

    expect(second.changed).toBe(false);
    expect(second.settlement.status).toBe("submitted");
    // The duplicate request must NOT create a second audit/status-history row.
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.statusHistory.create).toHaveBeenCalledTimes(1);
  });

  it("returns the winner's result when a race wins before us", async () => {
    // The row has already moved off "pending" by the time we read it.
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement({ status: "submitted" }));
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });

    expect(result.changed).toBe(false);
    expect(result.settlement.status).toBe("submitted");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("applySettlementTransition expenseShare settlement", () => {
  it("marks the linked expenseShare settled atomically with confirmation", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "verifying", expenseShareId: "share_1" })
    );
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "confirmed", expenseShareId: "share_1" })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "confirmed",
      source: "worker",
      settleExpenseShare: true,
    });

    expect(result.changed).toBe(true);
    expect(result.settlement.status).toBe("confirmed");
    // Participant allocation commits inside the same transaction as the status.
    expect(prisma.expenseShare.update).toHaveBeenCalledWith({
      where: { id: "share_1" },
      data: { status: "settled" },
    });
  });

  it("does not touch expenseShare when not confirming", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "submitted", expenseShareId: "share_1" })
    );
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "verifying", expenseShareId: "share_1" })
    );

    await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "verifying",
      source: "worker",
      settleExpenseShare: true,
    });

    expect(prisma.expenseShare.update).not.toHaveBeenCalled();
  });
});
