import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
    withdrawal: undefined,
    treasuryProposal: undefined,
    expenseShare: {
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
  const stellar = {
    getTransaction: vi.fn(),
  };
  const logger: any = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger.child = vi.fn(() => logger);
  return { prisma, stellar, logger };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({ stellar: h.stellar }));
vi.mock("pino", () => ({ default: vi.fn(() => h.logger) }));

import { runReconciliation } from "../src/worker/reconciliation";

const prisma = h.prisma;
const stellar = h.stellar;
const logger = h.logger;

const fakeSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  status: "pending",
  stellarTxHash: "deadbeef",
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  expenseShareId: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.settlement.findMany.mockResolvedValue([]);
});

describe("runReconciliation — settlements", () => {
  it("marks a settlement confirmed when Horizon reports a successful transaction", async () => {
    const settlement = fakeSettlement({ expenseShareId: "share_1" });
    prisma.settlement.findMany.mockResolvedValue([settlement]);
    stellar.getTransaction.mockResolvedValue({ successful: true });

    await runReconciliation({ intervalMs: 60_000 });

    expect(prisma.settlement.update).toHaveBeenCalledWith({
      where: { id: "settle_1" },
      data: { status: "confirmed" },
    });
    expect(prisma.expenseShare.update).toHaveBeenCalledWith({
      where: { id: "share_1" },
      data: { status: "settled" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("marks a settlement failed when Horizon reports the transaction failed", async () => {
    const settlement = fakeSettlement();
    prisma.settlement.findMany.mockResolvedValue([settlement]);
    stellar.getTransaction.mockResolvedValue({ successful: false });

    await runReconciliation({ intervalMs: 60_000 });

    expect(prisma.settlement.update).toHaveBeenCalledWith({
      where: { id: "settle_1" },
      data: { status: "failed" },
    });
  });

  it("leaves a settlement pending when the transaction is not yet visible and the timeout hasn't elapsed", async () => {
    const settlement = fakeSettlement({
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.settlement.findMany.mockResolvedValue([settlement]);
    stellar.getTransaction.mockResolvedValue(null);

    await runReconciliation({ intervalMs: 60_000, timeoutMs: 5 * 60_000 });

    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("marks a settlement failed when the transaction is missing and the timeout has elapsed", async () => {
    const settlement = fakeSettlement({
      createdAt: new Date(Date.now() - 10 * 60_000),
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    prisma.settlement.findMany.mockResolvedValue([settlement]);
    stellar.getTransaction.mockResolvedValue(null);

    await runReconciliation({ intervalMs: 60_000, timeoutMs: 5 * 60_000 });

    expect(prisma.settlement.update).toHaveBeenCalledWith({
      where: { id: "settle_1" },
      data: { status: "failed" },
    });
  });

  it("skips records without a stellarTxHash", async () => {
    const settlement = fakeSettlement({ stellarTxHash: null });
    prisma.settlement.findMany.mockResolvedValue([settlement]);

    await runReconciliation({ intervalMs: 60_000 });

    expect(stellar.getTransaction).not.toHaveBeenCalled();
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("logs the number of processed records for the cycle", async () => {
    prisma.settlement.findMany.mockResolvedValue([
      fakeSettlement({ id: "settle_1" }),
      fakeSettlement({ id: "settle_2" }),
    ]);
    stellar.getTransaction.mockResolvedValue({ successful: true });

    await runReconciliation({ intervalMs: 60_000 });

    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        totalProcessed: 2,
        processedByTable: expect.objectContaining({ settlement: 2 }),
      }),
      expect.stringContaining("2")
    );
  });

  it("continues to the next table when loading pending records fails", async () => {
    prisma.settlement.findMany.mockRejectedValue(new Error("db offline"));

    await expect(runReconciliation({ intervalMs: 60_000 })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });
});
