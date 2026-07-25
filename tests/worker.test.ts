import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const settlement = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const expenseShare = {
    update: vi.fn(),
  };
  const prisma: any = {
    settlement,
    expenseShare,
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };

  return {
    prisma,
    submitPayment: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(),
    buildPayment: vi.fn(),
    submitPayment: h.submitPayment,
  },
}));
vi.mock("../src/services/audit", () => ({ audit: h.audit }));
vi.mock("../src/worker/reconciliation", () => ({
  runReconciliation: vi.fn(),
  startReconciliation: vi.fn(() => () => {}),
}));
vi.mock("../src/services/anchor", () => ({
  anchorService: {
    getToml: vi.fn(),
    getTransactionStatus: vi.fn(),
  },
  mapAnchorStatus: vi.fn((status: string) => status),
}));

import { processSubmittedSettlements } from "../src/worker/index";

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

describe("processSubmittedSettlements", () => {
  it("confirms a submitted settlement and records the Stellar hash", async () => {
    const settlement = {
      id: "settle_1",
      shortCode: "ABC123",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "10.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment.mockResolvedValue("hash_123");

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledWith(
      "signed-xdr",
      expect.objectContaining({
        sourcePublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        destination: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        asset: { code: "USDC", issuer: null },
        amount: "10.00",
        memoCode: "ABC123",
      })
    );
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: expect.objectContaining({
          status: "confirmed",
          stellarTxHash: "hash_123",
        }),
      })
    );
    expect(h.audit).toHaveBeenCalled();
  });

  it("retries transient failures before confirming", async () => {
    const settlement = {
      id: "settle_2",
      shortCode: "XYZ999",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "5.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr-2",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce("hash_456");

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledTimes(3);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_2" },
        data: expect.objectContaining({
          status: "confirmed",
          stellarTxHash: "hash_456",
        }),
      })
    );
  });

  it("marks a settlement as failed when all retries are exhausted", async () => {
    const settlement = {
      id: "settle_3",
      shortCode: "FAIL1",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "5.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr-3",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.submitPayment.mockRejectedValue(new Error("timeout"));

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledTimes(4);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_3" },
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.any(String),
          retryCount: { increment: 1 },
        }),
      })
    );
    expect(h.audit).toHaveBeenCalled();
  });

  it("marks a settlement as failed immediately on non-transient error without retrying", async () => {
    const settlement = {
      id: "settle_4",
      shortCode: "NORETRY",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "5.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr-4",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.submitPayment.mockRejectedValue(new Error("invalid signature"));

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_4" },
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.any(String),
          retryCount: { increment: 1 },
        }),
      })
    );
  });
});
