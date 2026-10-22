import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    withdrawal: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  applyWithdrawalTransition,
  canTransitionWithdrawalStatus,
  isTerminalWithdrawalStatus,
  mapAnchorStatusToWithdrawalStatus,
} from "../src/services/withdrawal-status";

const prisma = h.prisma;

const fakeWithdrawal = (over: Record<string, any> = {}) => ({
  id: "wth_1",
  userId: "user_1",
  amount: "5",
  assetCode: "XLM",
  assetIssuer: null,
  memo: null,
  anchorTxId: "ANCH-TX-1",
  interactiveUrl: null,
  status: "pending",
  failureReason: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: the guarded update always "wins" unless a test says otherwise.
  prisma.withdrawal.updateMany.mockResolvedValue({ count: 1 });
});

describe("canTransitionWithdrawalStatus / isTerminalWithdrawalStatus", () => {
  it("treats completed, failed, expired, and refunded as terminal", () => {
    expect(isTerminalWithdrawalStatus("completed")).toBe(true);
    expect(isTerminalWithdrawalStatus("failed")).toBe(true);
    expect(isTerminalWithdrawalStatus("expired")).toBe(true);
    expect(isTerminalWithdrawalStatus("refunded")).toBe(true);
    expect(isTerminalWithdrawalStatus("processing")).toBe(false);
    expect(isTerminalWithdrawalStatus("pending")).toBe(false);
  });

  it("allows the documented forward transitions", () => {
    expect(canTransitionWithdrawalStatus("pending", "processing")).toBe(true);
    expect(canTransitionWithdrawalStatus("pending", "failed")).toBe(true);
    expect(canTransitionWithdrawalStatus("pending", "expired")).toBe(true);
    expect(canTransitionWithdrawalStatus("processing", "completed")).toBe(true);
    expect(canTransitionWithdrawalStatus("processing", "refunded")).toBe(true);
  });

  it("rejects regressions out of every terminal state", () => {
    expect(canTransitionWithdrawalStatus("completed", "processing")).toBe(false);
    expect(canTransitionWithdrawalStatus("failed", "pending")).toBe(false);
    expect(canTransitionWithdrawalStatus("expired", "processing")).toBe(false);
    expect(canTransitionWithdrawalStatus("refunded", "completed")).toBe(false);
  });

  it("rejects skipping backwards from processing to pending", () => {
    expect(canTransitionWithdrawalStatus("processing", "pending")).toBe(false);
  });
});

describe("mapAnchorStatusToWithdrawalStatus", () => {
  it("maps terminal anchor statuses directly", () => {
    expect(mapAnchorStatusToWithdrawalStatus("completed")).toBe("completed");
    expect(mapAnchorStatusToWithdrawalStatus("refunded")).toBe("refunded");
    expect(mapAnchorStatusToWithdrawalStatus("expired")).toBe("expired");
  });

  it("collapses anchor failure variants to failed", () => {
    expect(mapAnchorStatusToWithdrawalStatus("error")).toBe("failed");
    expect(mapAnchorStatusToWithdrawalStatus("no_market")).toBe("failed");
    expect(mapAnchorStatusToWithdrawalStatus("too_small")).toBe("failed");
    expect(mapAnchorStatusToWithdrawalStatus("too_large")).toBe("failed");
  });

  it("collapses every intermediate (known or unknown) anchor status to processing", () => {
    expect(mapAnchorStatusToWithdrawalStatus("pending_anchor")).toBe("processing");
    expect(mapAnchorStatusToWithdrawalStatus("pending_stellar")).toBe("processing");
    expect(mapAnchorStatusToWithdrawalStatus("some_future_status")).toBe("processing");
  });
});

describe("applyWithdrawalTransition", () => {
  it("applies an ordered sequence of updates and reaches the correct terminal state", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "pending" }));
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "processing" }));

    const first = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "processing",
      source: "user",
    });
    expect(first.changed).toBe(true);
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_1", status: "pending" },
      data: { status: "processing" },
    });

    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "processing" }));
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "completed" }));

    const second = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "completed",
      source: "webhook",
    });
    expect(second.changed).toBe(true);
    expect(second.withdrawal.status).toBe("completed");
  });

  it("is idempotent for a repeated identical status and writes no audit record", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal({ status: "completed" }));

    const result = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "completed",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("does not create a duplicate record or audit event for a duplicate callback", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal({ status: "completed" }));

    await applyWithdrawalTransition({ withdrawalId: "wth_1", nextStatus: "completed", source: "webhook" });
    await applyWithdrawalTransition({ withdrawalId: "wth_1", nextStatus: "completed", source: "webhook" });

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("ignores a stale out-of-order update that would regress an in-flight withdrawal", async () => {
    // A stale "pending"-implying callback arrives after the withdrawal
    // already advanced to "processing".
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal({ status: "processing" }));

    const result = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "pending",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("ignores any transition attempted out of a terminal state", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal({ status: "failed" }));

    const result = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "processing",
      source: "poll",
    });

    expect(result.changed).toBe(false);
    expect(result.withdrawal.status).toBe("failed");
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("produces the correct visible status for an anchor failure callback", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "processing" }));
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "failed" }));

    const result = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: mapAnchorStatusToWithdrawalStatus("error"),
      source: "webhook",
    });

    expect(result.changed).toBe(true);
    expect(result.withdrawal.status).toBe("failed");
  });

  it("never lets a user-sourced transition mark a withdrawal completed", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal({ status: "processing" }));

    const result = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "completed",
      source: "user",
    });

    expect(result.changed).toBe(false);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("treats a lost race on the guarded update as a no-op rather than a second transition", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "processing" }));
    prisma.withdrawal.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.withdrawal.findUnique.mockResolvedValueOnce(fakeWithdrawal({ status: "completed" }));

    const result = await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "completed",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(result.withdrawal.status).toBe("completed");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an update for an unknown withdrawal id", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(null);

    await expect(
      applyWithdrawalTransition({ withdrawalId: "missing", nextStatus: "completed", source: "webhook" })
    ).rejects.toMatchObject({ status: 404 });
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an update that does not belong to the claimed user", async () => {
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal({ userId: "someone_else" }));

    await expect(
      applyWithdrawalTransition({
        withdrawalId: "wth_1",
        nextStatus: "processing",
        source: "user",
        ownerUserId: "user_1",
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });
});
