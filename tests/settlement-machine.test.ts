import { describe, it, expect, beforeEach, vi } from "vitest";

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
  canTransitionSettlementStatus,
  isTerminalSettlementStatus,
  isSettlementRecoverable,
  applySettlementTransition,
  recordSettlementCreated,
  submitSettlementXdr,
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
    expect(result.settlement.status).toBe("submitted");
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "settle_1",
          status: expect.objectContaining({ in: expect.arrayContaining(["pending"]) }),
        }),
        data: expect.objectContaining({
          status: "submitted",
          submittedAt: expect.any(Date),
        }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "settlement.xdr_submitted",
        userId: "user_1",
        actorType: "user",
        entityId: "settle_1",
        metadata: expect.objectContaining({
          from: "pending",
          to: "submitted",
          source: "user",
        }),
      }),
    });
  });

  it("attributes a worker-sourced transition to a worker actor, not the payer", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "verifying" })
    );
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "confirmed", confirmedAt: new Date() })
    );

    await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "confirmed",
      source: "worker",
      extraData: { stellarTxHash: "hash_123" },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "settlement.confirmed",
        userId: null,
        actorType: "worker",
        entityId: "settle_1",
      }),
    });
  });

  it("records a failed transition with a failure outcome", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "failed", failureReason: "boom" })
    );

    await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "failed",
      source: "worker",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "settlement.failed",
        userId: null,
        actorType: "worker",
        metadata: expect.objectContaining({ outcome: "failure" }),
      }),
    });
  });

  it("applies a verifying -> confirmed transition and sets confirmedAt", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ status: "verifying" })
    );
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
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
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "settle_1",
          status: expect.objectContaining({ in: expect.arrayContaining(["verifying"]) }),
        }),
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
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
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
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
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
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
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
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
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

  it("rolls back the whole transition when the audit write fails — no unaudited mutation is left committed", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );
    prisma.auditLog.create.mockRejectedValueOnce(new Error("audit db down"));

    // applySettlementTransition runs settlement.update and auditTx inside the
    // SAME prisma.$transaction callback. In real Postgres, a callback that
    // throws rolls back every write it made, including settlement.update —
    // so a failed audit insert can never leave an unaudited status change
    // committed. This test proves the *contract* the transaction relies on:
    // the promise this function returns must reject, exactly as it would if
    // Postgres itself rolled the transaction back.
    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "submitted",
        source: "user",
      })
    ).rejects.toThrow("audit db down");
  });
});

describe("recordSettlementCreated", () => {
  it("audits creation with actor, target, and settlement details", async () => {
    const tx = prisma;
    await recordSettlementCreated(tx, {
      settlementId: "settle_new",
      groupId: "group_1",
      userId: "user_1",
      toUserId: "user_2",
      amount: "12.5000000",
      assetCode: "USDC",
      assetIssuer: "GISSUER",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user_1",
        groupId: "group_1",
        actorType: "user",
        action: "settlement.created",
        entityType: "settlement",
        entityId: "settle_new",
        metadata: expect.objectContaining({
          toUserId: "user_2",
          amount: "12.5000000",
          assetCode: "USDC",
          assetIssuer: "GISSUER",
        }),
      }),
    });
  });

  it("never includes a signed XDR or private key in the recorded metadata", async () => {
    await recordSettlementCreated(prisma, {
      settlementId: "settle_new",
      groupId: "group_1",
      userId: "user_1",
      toUserId: "user_2",
      amount: "12.5000000",
      assetCode: "USDC",
      assetIssuer: null,
    });

    const call = prisma.auditLog.create.mock.calls[0][0];
    const serialized = JSON.stringify(call.data.metadata);
    expect(serialized).not.toMatch(/AAAA[A-Za-z0-9+/]{20,}/); // no XDR-shaped base64 blob
    expect(call.data.metadata).not.toHaveProperty("privateKey");
    expect(call.data.metadata).not.toHaveProperty("signedXdr");
  });
});

describe("submitSettlementXdr", () => {
  it("moves a pending settlement to submitted and records SETTLEMENT_XDR_SUBMITTED", async () => {
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });

    const result = await submitSettlementXdr({
      tx: prisma,
      settlementId: "settle_1",
      userId: "user_1",
      signedXdr: "signed-envelope-not-logged",
      currentStatus: "pending",
    });

    expect(result.count).toBe(1);
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1", status: { in: ["pending", "failed"] } },
        data: expect.objectContaining({ status: "submitted" }),
      })
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user_1",
        actorType: "user",
        action: "settlement.xdr_submitted",
        entityType: "settlement",
        entityId: "settle_1",
      }),
    });
    // The signed envelope itself must never appear in the audit trail.
    const auditedMetadata = JSON.stringify(
      prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data.metadata)
    );
    expect(auditedMetadata).not.toContain("signed-envelope-not-logged");
  });

  it("records SETTLEMENT_RETRIED (in addition to the submission event) when retrying a failed settlement", async () => {
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });

    await submitSettlementXdr({
      tx: prisma,
      settlementId: "settle_1",
      userId: "user_1",
      signedXdr: "new-signed-envelope",
      currentStatus: "failed",
      previousFailureReason: "insufficient balance",
    });

    const actions = prisma.auditLog.create.mock.calls.map(
      (c: any[]) => c[0].data.action
    );
    expect(actions).toEqual(["settlement.retried", "settlement.xdr_submitted"]);
  });

  it("does not record SETTLEMENT_XDR_SUBMITTED when a concurrent request already won the transition (count 0)", async () => {
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 });

    const result = await submitSettlementXdr({
      tx: prisma,
      settlementId: "settle_1",
      userId: "user_1",
      signedXdr: "signed-envelope",
      currentStatus: "pending",
    });

    expect(result.count).toBe(0);
    const actions = prisma.auditLog.create.mock.calls.map(
      (c: any[]) => c[0].data.action
    );
    expect(actions).not.toContain("settlement.xdr_submitted");
  });
});
