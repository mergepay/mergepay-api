import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const anchorSession = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  };
  const prisma: any = {
    anchorSession,
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return { prisma, getTransactionStatus: vi.fn(), getToml: vi.fn() };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { loadAccount: vi.fn(), buildPayment: vi.fn(), submitPayment: vi.fn() },
}));
vi.mock("../src/services/audit", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/audit")>();
  return { ...actual, audit: vi.fn() };
});
vi.mock("../src/worker/reconciliation", () => ({
  runReconciliation: vi.fn(),
  startReconciliation: vi.fn(() => () => {}),
}));
vi.mock("../src/services/anchor", () => ({
  anchorService: {
    getToml: h.getToml,
    getTransactionStatus: h.getTransactionStatus,
  },
  mapAnchorStatus: (raw: string) => {
    switch (raw) {
      case "completed":
        return "completed";
      case "pending_user_transfer_start":
        return "pending_user_transfer_start";
      case "error":
        return "error";
      case "refunded":
        return "refunded";
      case "incomplete":
        return "incomplete";
      default:
        return "pending_anchor";
    }
  },
}));

import { reconcileAnchors } from "../src/worker/index";

const prisma = h.prisma;

function fakeSession(over: Record<string, any> = {}) {
  return {
    id: "session_1",
    userId: "user_1",
    status: "pending_anchor",
    externalTransactionId: "ext_1",
    anchorToken: "jwt",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getToml.mockResolvedValue({ transferServerSep24: "https://anchor.test/sep24" });
});

describe("reconcileAnchors", () => {
  it("applies a valid transition discovered via polling and audits it with source poll", async () => {
    const session = fakeSession();
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    h.getTransactionStatus.mockResolvedValue("completed");
    prisma.anchorSession.findUnique.mockResolvedValue(session);
    prisma.anchorSession.update.mockResolvedValue({ ...session, status: "completed" });

    await reconcileAnchors();

    expect(prisma.anchorSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { status: "completed" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        metadata: { from: "pending_anchor", to: "completed", source: "poll" },
      }),
    });
  });

  it("does not regress a session that the anchor briefly reports as pending again", async () => {
    const session = fakeSession({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    h.getTransactionStatus.mockResolvedValue("pending_anchor");
    prisma.anchorSession.findUnique.mockResolvedValue(session);

    await reconcileAnchors();

    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("continues reconciling remaining sessions if one poll attempt throws", async () => {
    const sessionA = fakeSession({ id: "session_a", externalTransactionId: "ext_a" });
    const sessionB = fakeSession({ id: "session_b", externalTransactionId: "ext_b" });
    prisma.anchorSession.findMany.mockResolvedValue([sessionA, sessionB]);
    h.getTransactionStatus
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce("completed");
    prisma.anchorSession.findUnique.mockResolvedValue(sessionB);
    prisma.anchorSession.update.mockResolvedValue({ ...sessionB, status: "completed" });

    await expect(reconcileAnchors()).resolves.not.toThrow();
    expect(prisma.anchorSession.update).toHaveBeenCalledWith({
      where: { id: "session_b" },
      data: { status: "completed" },
    });
  });
});
