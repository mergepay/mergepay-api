import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const anchorSession = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    // Sessions are claimed with a short-lived database lease
    // (claimedAt/claimedBy/leaseExpiresAt) before polling, so two worker
    // processes can never poll the same session concurrently.
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma: any = {
    anchorSession,
    auditLog: { create: vi.fn() },
    statusHistory: { create: vi.fn() },
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    audit: vi.fn(),
    getToml: vi.fn(),
    pollTransaction: vi.fn(),
    applyAnchorSessionTransition: vi.fn().mockResolvedValue({ changed: true }),
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
vi.mock("../src/services/anchor-status", () => ({
  applyAnchorSessionTransition: h.applyAnchorSessionTransition,
  isTerminalAnchorStatus: vi.fn((status: string) => status === "error" || status === "completed" || status === "refunded"),
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
    retryCount: 0,
    failureReason: null,
    lastPolledAt: null,
    errorCategory: null,
    nextAttemptAt: null,
    claimedAt: null,
    claimedBy: null,
    leaseExpiresAt: null,
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
    status: "pending_anchor",
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

describe("reconcileAnchors", () => {
  it("applies a transition discovered via polling and audits the terminal state", async () => {
    const session = fakeSession();
    prisma.anchorSession.findMany.mockResolvedValue([session]);
    prisma.anchorSession.findUnique.mockResolvedValue(session);
    h.pollTransaction.mockResolvedValue(pollResult("completed"));
    prisma.anchorSession.update.mockResolvedValue({ ...session, status: "completed" });
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    await reconcileAnchors();

    // Status advancement now uses applyAnchorSessionTransition
    expect(h.applyAnchorSessionTransition).toHaveBeenCalledWith({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "poll",
      expectedCurrentStatus: "pending_anchor",
      rawStatus: "completed",
      reason: undefined,
      extraData: expect.objectContaining({
        lastPolledAt: expect.any(Date),
        failureReason: null,
        errorCategory: null,
        nextAttemptAt: null,
        retryCount: 0,
      }),
    });
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
    prisma.anchorSession.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === "session_a" ? sessionA : sessionB
    );
    h.pollTransaction
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValueOnce(pollResult("completed"));
    prisma.anchorSession.update.mockResolvedValue({ ...sessionB, status: "completed" });
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    await expect(reconcileAnchors()).resolves.not.toThrow();
    expect(h.applyAnchorSessionTransition).toHaveBeenCalledWith({
      sessionId: "session_b",
      nextStatus: "completed",
      source: "poll",
      expectedCurrentStatus: "pending_anchor",
      rawStatus: "completed",
      reason: undefined,
      extraData: expect.objectContaining({
        lastPolledAt: expect.any(Date),
        failureReason: null,
        errorCategory: null,
        nextAttemptAt: null,
        retryCount: 0,
      }),
    });
  });

  describe("retry logic and exponential backoff", () => {
    it("retries transient failures with exponential backoff", async () => {
      const session = fakeSession({ retryCount: 0 });
      prisma.anchorSession.findMany.mockResolvedValue([session]);
      prisma.anchorSession.findUnique.mockResolvedValue(session);
      h.pollTransaction.mockResolvedValue(errorPollResult("connection timeout", "transient"));
      prisma.anchorSession.update.mockResolvedValue(session);
      prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

      await reconcileAnchors();

      expect(prisma.anchorSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "session_1" },
          data: expect.objectContaining({
            retryCount: 1,
            errorCategory: "transient",
            nextAttemptAt: expect.any(Date),
          }),
        })
      );
    });

    it("marks permanent failures as error immediately without retrying", async () => {
      const session = fakeSession({ retryCount: 0 });
      prisma.anchorSession.findMany.mockResolvedValue([session]);
      prisma.anchorSession.findUnique.mockResolvedValue(session);
      h.pollTransaction.mockResolvedValue(errorPollResult("malformed response", "permanent"));
      prisma.anchorSession.update.mockResolvedValue({ ...session, status: "error" });
      prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

      await reconcileAnchors();

      // Permanent failures now use applyAnchorSessionTransition
      expect(h.applyAnchorSessionTransition).toHaveBeenCalledWith({
        sessionId: "session_1",
        nextStatus: "error",
        source: "poll",
        expectedCurrentStatus: "pending_anchor",
        reason: "malformed response",
        extraData: expect.objectContaining({
          lastPolledAt: expect.any(Date),
          failureReason: "malformed response",
          errorCategory: "permanent",
          nextAttemptAt: null,
          retryCount: 0,
        }),
      });
    });

    it("marks exhausted retries as dead letter with permanent error", async () => {
      const session = fakeSession({ retryCount: 4 }); // maxAttempts is 5, so retryCount=4 exhausts (attempt=5)
      prisma.anchorSession.findMany.mockResolvedValue([session]);
      prisma.anchorSession.findUnique.mockResolvedValue(session);
      h.pollTransaction.mockResolvedValue(errorPollResult("connection timeout", "transient"));
      prisma.anchorSession.update.mockResolvedValue({ ...session, status: "error" });
      prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
      h.applyAnchorSessionTransition.mockResolvedValue({ changed: true });

      await reconcileAnchors();

      // The implementation now uses applyAnchorSessionTransition for permanent failures
      expect(h.applyAnchorSessionTransition).toHaveBeenCalledWith({
        sessionId: "session_1",
        nextStatus: "error",
        source: "poll",
        expectedCurrentStatus: "pending_anchor",
        reason: "connection timeout (retries exhausted after 5 attempts)",
        extraData: expect.objectContaining({
          lastPolledAt: expect.any(Date),
          failureReason: "connection timeout (retries exhausted after 5 attempts)",
          errorCategory: "permanent",
          nextAttemptAt: null,
          retryCount: 0,
        }),
      });
    });

    it("increments retry count for each transient failure", async () => {
      const session = fakeSession({ retryCount: 1 });
      prisma.anchorSession.findMany.mockResolvedValue([session]);
      prisma.anchorSession.findUnique.mockResolvedValue(session);
      h.pollTransaction.mockResolvedValue(errorPollResult("service unavailable", "transient"));
      prisma.anchorSession.update.mockResolvedValue(session);
      prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

      await reconcileAnchors();

      expect(prisma.anchorSession.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "session_1" },
          data: expect.objectContaining({
            retryCount: 2,
          }),
        })
      );
    });

    it("schedules next attempt with delay based on retry policy", async () => {
      const session = fakeSession({ retryCount: 0 });
      prisma.anchorSession.findMany.mockResolvedValue([session]);
      prisma.anchorSession.findUnique.mockResolvedValue(session);
      h.pollTransaction.mockResolvedValue(errorPollResult("timeout", "transient"));
      prisma.anchorSession.update.mockResolvedValue(session);
      prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

      await reconcileAnchors();

      const updateCall = prisma.anchorSession.update.mock.calls[0];
      const nextAttemptAt = updateCall[0].data.nextAttemptAt;
      
      expect(nextAttemptAt).toBeInstanceOf(Date);
      expect(nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    });
  });
});
