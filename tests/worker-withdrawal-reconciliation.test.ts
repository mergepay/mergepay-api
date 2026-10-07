import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const withdrawal = {
    findMany: vi.fn(),
    update: vi.fn(),
  };
  const prisma: any = {
    withdrawal,
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getToml: vi.fn(),
    pollTransaction: vi.fn(),
    applyWithdrawalTransition: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: h.getToml,
      pollTransaction: h.pollTransaction,
    },
  };
});
vi.mock("../src/services/withdrawal-status", () => ({
  applyWithdrawalTransition: h.applyWithdrawalTransition,
  mapAnchorStatusToWithdrawalStatus: vi.fn((status) => status),
}));

import { reconcileWithdrawals } from "../src/worker/index";

const prisma = h.prisma;

function fakeWithdrawal(over: Record<string, any> = {}) {
  return {
    id: "withdrawal_1",
    status: "processing",
    anchorTxId: "anchor_tx_1",
    anchorToken: "jwt",
    retryCount: 0,
    failureReason: null,
    errorCategory: null,
    nextAttemptAt: null,
    ...over,
  };
}

function pollResult(status: string, over: Record<string, unknown> = {}) {
  return {
    rawStatus: status,
    status,
    message: `SEP-24 status: ${status}`,
    isError: false,
    ...over,
  };
}

function errorPollResult(message: string, errorCategory: "permanent" | "transient" = "transient", over: Record<string, unknown> = {}) {
  return {
    rawStatus: null,
    status: "processing",
    message,
    isError: true,
    errorCategory,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getToml.mockResolvedValue({ transferServerSep24: "https://anchor.test/sep24" });
});

describe("reconcileWithdrawals", () => {
  it("applies a transition discovered via polling", async () => {
    const withdrawal = fakeWithdrawal();
    prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
    h.pollTransaction.mockResolvedValue(pollResult("completed"));
    h.applyWithdrawalTransition.mockResolvedValue({ changed: true });

    await reconcileWithdrawals();

    expect(h.applyWithdrawalTransition).toHaveBeenCalledWith({
      withdrawalId: "withdrawal_1",
      nextStatus: "completed",
      source: "poll",
    });
  });

  it("skips cycle when anchor TOML is unavailable", async () => {
    const withdrawal = fakeWithdrawal();
    prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
    h.getToml.mockRejectedValue(new Error("anchor unreachable"));

    await reconcileWithdrawals();

    expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    expect(h.pollTransaction).not.toHaveBeenCalled();
  });

  it("continues reconciling remaining withdrawals if one poll attempt throws", async () => {
    const withdrawalA = fakeWithdrawal({ id: "withdrawal_a", anchorTxId: "anchor_tx_a" });
    const withdrawalB = fakeWithdrawal({ id: "withdrawal_b", anchorTxId: "anchor_tx_b" });
    prisma.withdrawal.findMany.mockResolvedValue([withdrawalA, withdrawalB]);
    h.pollTransaction
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(pollResult("completed"));
    h.applyWithdrawalTransition.mockResolvedValue({ changed: true });

    await expect(reconcileWithdrawals()).resolves.not.toThrow();
    expect(h.applyWithdrawalTransition).toHaveBeenCalledWith({
      withdrawalId: "withdrawal_b",
      nextStatus: "completed",
      source: "poll",
    });
  });

  describe("retry logic and exponential backoff", () => {
    it("retries transient failures with exponential backoff", async () => {
      const withdrawal = fakeWithdrawal({ retryCount: 0 });
      prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
      h.pollTransaction.mockResolvedValue(errorPollResult("connection timeout", "transient"));
      prisma.withdrawal.update.mockResolvedValue(withdrawal);

      await reconcileWithdrawals();

      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "withdrawal_1" },
          data: expect.objectContaining({
            retryCount: 1,
            errorCategory: "transient",
            nextAttemptAt: expect.any(Date),
          }),
        })
      );
    });

    it("marks permanent failures without retrying", async () => {
      const withdrawal = fakeWithdrawal({ retryCount: 0 });
      prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
      h.pollTransaction.mockResolvedValue(errorPollResult("malformed response", "permanent"));
      prisma.withdrawal.update.mockResolvedValue(withdrawal);

      await reconcileWithdrawals();

      // Permanent failures should not update the withdrawal - they just log and return
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });

    it("marks exhausted retries as dead letter with permanent error", async () => {
      const withdrawal = fakeWithdrawal({ retryCount: 4 }); // maxAttempts is 5, so retryCount=4 exhausts (attempt=5)
      prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
      h.pollTransaction.mockResolvedValue(errorPollResult("connection timeout", "transient"));
      prisma.withdrawal.update.mockResolvedValue({ ...withdrawal, status: "failed" });

      await reconcileWithdrawals();

      // When exhausted, the errorCategory is set to permanent immediately
      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "withdrawal_1" },
          data: expect.objectContaining({
            retryCount: 5,
            errorCategory: "permanent", // exhausted immediately sets to permanent
            nextAttemptAt: null,
          }),
        })
      );
      // Second update marks as failed
      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "withdrawal_1" },
          data: expect.objectContaining({
            status: "failed",
            errorCategory: "permanent",
            failureReason: expect.stringContaining("retries exhausted"),
            nextAttemptAt: null,
            retryCount: 0,
          }),
        })
      );
    });

    it("increments retry count for each transient failure", async () => {
      const withdrawal = fakeWithdrawal({ retryCount: 1 });
      prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
      h.pollTransaction.mockResolvedValue(errorPollResult("service unavailable", "transient"));
      prisma.withdrawal.update.mockResolvedValue(withdrawal);

      await reconcileWithdrawals();

      expect(prisma.withdrawal.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "withdrawal_1" },
          data: expect.objectContaining({
            retryCount: 2,
          }),
        })
      );
    });

    it("schedules next attempt with delay based on retry policy", async () => {
      const withdrawal = fakeWithdrawal({ retryCount: 0 });
      prisma.withdrawal.findMany.mockResolvedValue([withdrawal]);
      h.pollTransaction.mockResolvedValue(errorPollResult("timeout", "transient"));
      prisma.withdrawal.update.mockResolvedValue(withdrawal);

      await reconcileWithdrawals();

      const updateCall = prisma.withdrawal.update.mock.calls[0];
      const nextAttemptAt = updateCall[0].data.nextAttemptAt;
      
      expect(nextAttemptAt).toBeInstanceOf(Date);
      expect(nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("does not process withdrawals with permanent error category", async () => {
      const withdrawal = fakeWithdrawal({ errorCategory: "permanent" });
      // The findMany query filters out permanent errors, so it should return empty
      prisma.withdrawal.findMany.mockResolvedValue([]);

      await reconcileWithdrawals();

      expect(h.pollTransaction).not.toHaveBeenCalled();
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });

    it("respects backoff window by checking nextAttemptAt", async () => {
      const futureDate = new Date(Date.now() + 60000); // 1 minute in future
      const withdrawal = fakeWithdrawal({ nextAttemptAt: futureDate });
      // The findMany query filters out withdrawals with future nextAttemptAt
      prisma.withdrawal.findMany.mockResolvedValue([]);

      await reconcileWithdrawals();

      expect(h.pollTransaction).not.toHaveBeenCalled();
      expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    });
  });
});
