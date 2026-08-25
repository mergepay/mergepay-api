import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    auditLog: { create: vi.fn() },
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { audit, auditTx, auditData } from "../src/services/audit";

const prisma = h.prisma;

// Values that must never survive into a stored audit record, however a
// caller's metadata object happens to be shaped.
const SENSITIVE_FIXTURES = {
  privateKey: "SBSEED000000000000000000000000000000000000000000000000000000",
  signedXdr: "AAAAAgAAAAB...signed-envelope...",
  transactionXdr: "AAAAAgAAAAB...another-envelope...",
  authToken: "Bearer eyJhbGciOiJIUzI1NiJ9.secret.sig",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("auditData", () => {
  it("defaults actorType to \"user\" when userId is set", () => {
    const data = auditData({
      userId: "user_1",
      action: "settlement.created",
      entityType: "settlement",
      entityId: "settle_1",
    });
    expect(data.actorType).toBe("user");
    expect(data.userId).toBe("user_1");
  });

  it("defaults actorType to \"system\" when userId is absent — never blank", () => {
    const data = auditData({
      action: "settlement.confirmed",
      entityType: "settlement",
      entityId: "settle_1",
    });
    expect(data.actorType).toBe("system");
    expect(data.userId).toBeNull();
  });

  it("respects an explicit actorType override (worker)", () => {
    const data = auditData({
      userId: null,
      actorType: "worker",
      action: "settlement.confirmed",
      entityType: "settlement",
      entityId: "settle_1",
    });
    expect(data.actorType).toBe("worker");
    expect(data.userId).toBeNull();
  });

  it("stores outcome inside metadata, including the distinct \"rejected\" value", () => {
    const data = auditData({
      action: "settlement.rejected",
      entityType: "settlement",
      entityId: "settle_1",
      outcome: "rejected",
    });
    expect((data.metadata as any).outcome).toBe("rejected");
    expect(data.action).not.toBe("settlement.failed");
  });

  it.each(Object.entries(SENSITIVE_FIXTURES))(
    "throws when metadata contains a top-level %s",
    (key, value) => {
      expect(() =>
        auditData({
          action: "settlement.confirmed",
          entityType: "settlement",
          entityId: "settle_1",
          metadata: { [key]: value },
        })
      ).toThrow(/forbidden key/i);
    }
  );

  it("throws when a forbidden key is nested inside metadata", () => {
    expect(() =>
      auditData({
        action: "settlement.confirmed",
        entityType: "settlement",
        entityId: "settle_1",
        metadata: { request: { body: { signedXdr: SENSITIVE_FIXTURES.signedXdr } } },
      })
    ).toThrow(/forbidden key/i);
  });

  it("allows ordinary, non-sensitive metadata through untouched", () => {
    const data = auditData({
      action: "settlement.created",
      entityType: "settlement",
      entityId: "settle_1",
      metadata: { amount: "10.0000000", assetCode: "USDC", toUserId: "user_2" },
    });
    expect((data.metadata as any).amount).toBe("10.0000000");
  });
});

describe("audit (best-effort)", () => {
  it("writes the record via prisma.auditLog.create", async () => {
    await audit({
      userId: "user_1",
      action: "settlement.created",
      entityType: "settlement",
      entityId: "settle_1",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "settlement.created", actorType: "user" }),
    });
  });

  it("never throws when the underlying write fails", async () => {
    prisma.auditLog.create.mockRejectedValueOnce(new Error("connection reset"));
    await expect(
      audit({
        userId: "user_1",
        action: "settlement.created",
        entityType: "settlement",
        entityId: "settle_1",
      })
    ).resolves.toBeUndefined();
  });

  it("never throws when metadata fails the sensitive-key safeguard, and never writes the record", async () => {
    await expect(
      audit({
        userId: "user_1",
        action: "settlement.confirmed",
        entityType: "settlement",
        entityId: "settle_1",
        metadata: { signedXdr: SENSITIVE_FIXTURES.signedXdr },
      })
    ).resolves.toBeUndefined();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("auditTx (transactional)", () => {
  const fakeTx = () => ({ auditLog: { create: vi.fn() } } as any);

  it("writes the record on the passed transaction client", async () => {
    const tx = fakeTx();
    await auditTx(tx, {
      userId: "user_1",
      action: "settlement.created",
      entityType: "settlement",
      entityId: "settle_1",
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "settlement.created" }),
    });
  });

  it("propagates a metadata safeguard failure instead of swallowing it — so the caller's transaction rolls back", async () => {
    const tx = fakeTx();
    await expect(
      auditTx(tx, {
        userId: "user_1",
        action: "settlement.confirmed",
        entityType: "settlement",
        entityId: "settle_1",
        metadata: { privateKey: SENSITIVE_FIXTURES.privateKey },
      })
    ).rejects.toThrow(/forbidden key/i);
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("propagates a database failure instead of swallowing it", async () => {
    const tx = fakeTx();
    tx.auditLog.create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      auditTx(tx, {
        userId: "user_1",
        action: "settlement.created",
        entityType: "settlement",
        entityId: "settle_1",
      })
    ).rejects.toThrow("db down");
  });
});
