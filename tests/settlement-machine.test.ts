import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  canTransitionSettlementStatus,
  isTerminalSettlementStatus,
  isSettlementRecoverable,
  applySettlementTransition,
  classifySettlementError,
  type SettlementStatus,
} from "../src/services/settlement-machine";
import { AppError } from "../src/errors";

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
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("canTransitionSettlementStatus", () => {
  const legal: [SettlementStatus, SettlementStatus][] = [
    ["pending", "submitted"],
    ["pending", "failed"],
    ["submitted", "verifying"],
    ["submitted", "failed"],
    ["verifying", "confirmed"],
    ["verifying", "failed"],
    ["verifying", "needs_review"],
    ["verifying", "submitted"],
    ["needs_review", "confirmed"],
    ["needs_review", "failed"],
  ];

  const illegal: [SettlementStatus, SettlementStatus][] = [
    ["pending", "confirmed"],
    ["pending", "verifying"],
    ["pending", "needs_review"],
    ["submitted", "confirmed"],
    ["submitted", "needs_review"],
    ["submitted", "pending"],
    ["confirmed", "pending"],
    ["confirmed", "submitted"],
    ["confirmed", "verifying"],
    ["confirmed", "failed"],
    ["confirmed", "needs_review"],
    ["failed", "pending"],
    ["failed", "submitted"],
    ["failed", "verifying"],
    ["failed", "confirmed"],
    ["failed", "needs_review"],
    ["needs_review", "pending"],
    ["needs_review", "submitted"],
    ["needs_review", "verifying"],
  ];

  it.each(legal)("allows transition %s -> %s", (from, to) => {
    expect(canTransitionSettlementStatus(from, to)).toBe(true);
  });

  it.each(illegal)("rejects transition %s -> %s", (from, to) => {
    expect(canTransitionSettlementStatus(from, to)).toBe(false);
  });
});

describe("isTerminalSettlementStatus", () => {
  it("returns true for confirmed", () => {
    expect(isTerminalSettlementStatus("confirmed")).toBe(true);
  });
  it("returns true for failed", () => {
    expect(isTerminalSettlementStatus("failed")).toBe(true);
  });
  it.each(["pending", "submitted", "verifying", "needs_review", "unknown"])(
    "returns false for %s",
    (s) => {
      expect(isTerminalSettlementStatus(s)).toBe(false);
    }
  );
});

describe("isSettlementRecoverable", () => {
  it.each(["pending", "submitted", "verifying"])(
    "returns true for %s",
    (s) => {
      expect(isSettlementRecoverable(s)).toBe(true);
    }
  );
  it.each(["confirmed", "failed", "needs_review", "unknown"])(
    "returns false for %s",
    (s) => {
      expect(isSettlementRecoverable(s)).toBe(false);
    }
  );
});

describe("classifySettlementError", () => {
  it("classifies 4xx (non-429) AppErrors as permanent", () => {
    const err = new AppError(400, "BAD_REQUEST", "invalid");
    expect(classifySettlementError(err)).toBe("permanent");
  });

  it("classifies 429 AppErrors as transient", () => {
    const err = new AppError(429, "RATE_LIMITED", "too many");
    expect(classifySettlementError(err)).toBe("transient");
  });

  it("classifies 5xx AppErrors as transient", () => {
    const err = new AppError(502, "UPSTREAM_ERROR", "horizon error");
    expect(classifySettlementError(err)).toBe("transient");
  });

  it("classifies XDR_MISMATCH as permanent", () => {
    const err = new AppError(400, "XDR_MISMATCH", "signature mismatch");
    expect(classifySettlementError(err)).toBe("permanent");
  });

  it("classifies timeout errors as transient", () => {
    expect(classifySettlementError(new Error("timeout"))).toBe("transient");
  });

  it("classifies Horizon connection errors as transient", () => {
    expect(classifySettlementError(new Error("connection reset"))).toBe("transient");
  });

  it("classifies invalid signature errors as permanent", () => {
    expect(classifySettlementError(new Error("invalid signature"))).toBe("permanent");
  });

  it("classifies unknown errors as transient (safe default)", () => {
    expect(classifySettlementError(new Error("unknown error"))).toBe("transient");
  });
});

describe("applySettlementTransition", () => {
  it("applies a pending -> submitted transition and sets submittedAt", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted", submittedAt: new Date() })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });

    expect(result.changed).toBe(true);
    expect(result.settlement.status).toBe("submitted");
    expect(prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: expect.objectContaining({
          status: "submitted",
          submittedAt: expect.any(Date),
        }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "settlement.status_changed",
        entityId: "settle_1",
        metadata: expect.objectContaining({
          from: "pending",
          to: "submitted",
          source: "user",
        }),
      }),
    });
  });

  it("applies a verifying -> confirmed transition and sets confirmedAt", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "verifying" })
    );
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "confirmed", confirmedAt: new Date() })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "confirmed",
      source: "worker",
      extraData: { stellarTxHash: "hash_123" },
    });

    expect(result.changed).toBe(true);
    expect(result.settlement.status).toBe("confirmed");
    expect(prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: expect.objectContaining({
          status: "confirmed",
          confirmedAt: expect.any(Date),
          stellarTxHash: "hash_123",
        }),
      })
    );
  });

  it("rejects an illegal transition (pending -> confirmed)", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());

    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "confirmed",
        source: "user",
      })
    ).rejects.toMatchObject({ status: 409, code: "INVALID_TRANSITION" });
    expect(prisma.settlement.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects transition from terminal states (confirmed -> failed)", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "confirmed" })
    );

    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "failed",
        source: "system",
      })
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("is idempotent when transitioning to the current status", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "submitted",
      source: "user",
    });

    expect(result.changed).toBe(false);
    expect(prisma.settlement.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("persists extraData on duplicate status without re-auditing", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "verifying" })
    );
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "verifying", retryCount: 2 })
    );

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "verifying",
      source: "worker",
      extraData: { retryCount: 2 },
    });

    expect(result.changed).toBe(false);
    expect(prisma.settlement.update).toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("enforces ownership when ownerUserId is specified", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ fromUserId: "someone_else" })
    );

    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "submitted",
        source: "user",
        ownerUserId: "user_1",
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("throws not found for a missing settlement", async () => {
    prisma.settlement.findUnique.mockResolvedValue(null);

    await expect(
      applySettlementTransition({
        settlementId: "missing",
        nextStatus: "failed",
        source: "worker",
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
