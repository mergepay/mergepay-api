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
  return {
    prisma,
    audit: vi.fn(),
    getToml: vi.fn(),
    pollTransaction: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { loadAccount: vi.fn(), buildPayment: vi.fn(), submitPayment: vi.fn() },
}));
vi.mock("../src/services/audit", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/audit")>();
  return { ...actual, audit: h.audit };
});
vi.mock("../src/worker/reconciliation", () => ({
  runReconciliation: vi.fn(),
  startReconciliation: vi.fn(() => () => {}),
}));
// Partial mock: only the anchor-facing calls are replaced. The status tables
// (TERMINAL_ANCHOR_STATUSES, AUDITABLE_ANCHOR_STATUSES) and mapAnchorStatus
// come from the real module, since the worker reads them at import time and
// their contents are part of the behaviour under test.
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

import { reconcileAnchors } from "../src/worker/index";

const prisma = h.prisma;

function fakeSession(over: Record<string, any> = {}) {
  return {
    id: "session_1",
    userId: "user_1",
    status: "pending_anchor",
    externalTransactionId: "ext_1",
    anchorToken: "jwt",
    retryCount: 0,
    failureReason: null,
    lastPolledAt: null,
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

beforeEach(() => {
  vi.clearAllMocks();
  h.getToml.mockResolvedValue({ transferServerSep24: "https://anchor.test/sep24" });
});

describe("reconcileAnchors", () => {
  it("applies a transition discovered via polling and audits the terminal state", async () => {
    const session = fakeSession();
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    h.pollTransaction.mockResolvedValue(pollResult("completed"));
    prisma.anchorSession.update.mockResolvedValue({ ...session, status: "completed" });

    await reconcileAnchors();

    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_1" },
        data: expect.objectContaining({ status: "completed" }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "anchor.session.completed",
        entityId: "session_1",
        metadata: expect.objectContaining({
          previousStatus: "pending_anchor",
          status: "completed",
        }),
      })
    );
  });

  it("does not regress a session that the anchor briefly reports as pending again", async () => {
    const session = fakeSession({ status: "completed" });
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    h.pollTransaction.mockResolvedValue(pollResult("pending_anchor"));

    await reconcileAnchors();

    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("continues reconciling remaining sessions if one poll attempt throws", async () => {
    const sessionA = fakeSession({ id: "session_a", externalTransactionId: "ext_a" });
    const sessionB = fakeSession({ id: "session_b", externalTransactionId: "ext_b" });
    prisma.anchorSession.findMany.mockResolvedValue([sessionA, sessionB]);
    h.pollTransaction
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(pollResult("completed"));
    prisma.anchorSession.update.mockResolvedValue({ ...sessionB, status: "completed" });

    await expect(reconcileAnchors()).resolves.not.toThrow();
    expect(prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "session_b" },
        data: expect.objectContaining({ status: "completed" }),
      })
    );
  });
});
