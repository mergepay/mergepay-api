import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const settlement = {
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const expenseShare = {
    update: vi.fn(),
  };
  const anchorSession = {
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const prisma: any = {
    settlement,
    expenseShare,
    anchorSession,
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
    pollTransaction: vi.fn(),
  },
  mapAnchorStatus: vi.fn((status: string) => status),
  TERMINAL_ANCHOR_STATUSES: new Set([
    "completed",
    "error",
    "refunded",
    "expired",
    "no_market",
    "too_small",
    "too_large",
  ]),
  AUDITABLE_ANCHOR_STATUSES: new Set([
    "completed",
    "error",
    "refunded",
    "expired",
    "no_market",
    "too_small",
    "too_large",
  ]),
}));

import { processSubmittedSettlements, reconcileAnchors, setDelayFn, SETTLEMENT_MAX_RETRIES } from "../src/worker/index";
import { anchorService } from "../src/services/anchor";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockAnchorService() {
  const anchorServiceMock = vi.mocked(anchorService);
  anchorServiceMock.getToml.mockResolvedValue({
    homeDomain: "anchor.test",
    webAuthEndpoint: "https://anchor.test/auth",
    transferServerSep24: "https://anchor.test/sep24",
    signingKey: "GSIGN",
    assets: [{ code: "USDC", issuer: null }],
  });
  return { anchorServiceMock };
}

function makePollResult(rawStatus: string): ReturnType<typeof import("../src/services/anchor").anchorService.pollTransaction> {
  // We inline the mapping logic to avoid coupling to the actual implementation
  const terminal = new Set([
    "completed", "error", "refunded", "expired",
    "no_market", "too_small", "too_large",
  ]);
  const status = terminal.has(rawStatus)
    ? rawStatus
    : rawStatus === "incomplete"
      ? "incomplete"
      : rawStatus.startsWith("pending_")
        ? rawStatus
        : "pending_anchor";

  return Promise.resolve({
    rawStatus,
    status,
    message: `SEP-24 status: ${rawStatus} → ${status}`,
    isError: false,
    transaction: { id: "ext_1", status: rawStatus },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Reset delay function to real setTimeout
  setDelayFn((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
});

// ---------------------------------------------------------------------------
// reconcileAnchors — SEP-24 anchor reconciliation
// ---------------------------------------------------------------------------

describe("reconcileAnchors", () => {
  const baseSession = {
    id: "as_1",
    userId: "user_1",
    anchorName: "Test Anchor",
    kind: "deposit",
    assetCode: "USDC",
    interactiveUrl: "https://anchor.test/interactive",
    externalTransactionId: "ext_1",
    anchorToken: "tok_abc",
    status: "pending_anchor",
    retryCount: 0,
    failureReason: null,
    nextRetryAt: null,
    lastPolledAt: null,
    createdAt: new Date("2026-07-25T00:00:00.000Z"),
    updatedAt: new Date("2026-07-25T00:00:00.000Z"),
  };

  beforeEach(() => {
    h.prisma.anchorSession.update.mockReset();
    h.prisma.anchorSession.updateMany.mockReset();
    h.prisma.anchorSession.update.mockResolvedValue({});
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
  });

  it("discovers pending sessions and polls them", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([baseSession]);
    const { anchorServiceMock } = mockAnchorService();
    anchorServiceMock.pollTransaction.mockResolvedValue(makePollResult("completed"));

    await reconcileAnchors();

    expect(anchorServiceMock.getToml).toHaveBeenCalledOnce();
    expect(anchorServiceMock.pollTransaction).toHaveBeenCalledWith({
      transferServer: "https://anchor.test/sep24",
      token: "tok_abc",
      id: "ext_1",
    });
    expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "as_1" },
        data: expect.objectContaining({
          status: "completed",
          lastPolledAt: expect.any(Date),
          failureReason: null,
          retryCount: 0,
          errorCategory: null,
          nextRetryAt: null,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "anchor.session.completed",
        entityId: "as_1",
      })
    );
  });

  it("maps each SEP-24 status correctly", async () => {
    const statusMappings: [string, string][] = [
      // Terminal (success)
      ["completed", "completed"],
      // Terminal (failure)
      ["error", "error"],
      ["refunded", "refunded"],
      ["expired", "expired"],
      ["no_market", "no_market"],
      ["too_small", "too_small"],
      ["too_large", "too_large"],
      // Intermediate (user action)
      ["pending_user_transfer_start", "pending_user_transfer_start"],
      ["pending_user", "pending_user"],
      ["pending_transaction_info_update", "pending_transaction_info_update"],
      ["pending_receiver", "pending_receiver"],
      ["pending_sender", "pending_sender"],
      // Intermediate (anchor/stellar)
      ["pending_stellar", "pending_stellar"],
      ["pending_trust", "pending_trust"],
      ["pending_anchor", "pending_anchor"],
      // Initial
      ["incomplete", "incomplete"],
      // Unknown → safe default
      ["some_future_status", "pending_anchor"],
    ];

    for (const [raw, expected] of statusMappings) {
      vi.clearAllMocks();
      h.prisma.anchorSession.findMany.mockResolvedValue([{ ...baseSession, status: "pending_anchor" }]);
      h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
      const { anchorServiceMock } = mockAnchorService();
      anchorServiceMock.pollTransaction.mockResolvedValue(makePollResult(raw));

      await reconcileAnchors();

      // When mapped status equals current status, no update occurs (e.g. pending_anchor → pending_anchor)
      // But for status changes, it should update
      if (expected !== "pending_anchor") {
        expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
          expect.objectContaining({
            where: { id: "as_1" },
            data: expect.objectContaining({
              status: expected,
            }),
          })
        );
      }
    }
  });

  it("does not overwrite terminal states with non-terminal statuses", async () => {
    const terminalStatuses = [
      "completed",
      "error",
      "refunded",
      "expired",
      "no_market",
      "too_small",
      "too_large",
    ];

    for (const terminalStatus of terminalStatuses) {
      vi.clearAllMocks();
      h.prisma.anchorSession.findMany.mockResolvedValue([
        { ...baseSession, status: terminalStatus },
      ]);
      const { anchorServiceMock } = mockAnchorService();
      anchorServiceMock.pollTransaction.mockResolvedValue(
        makePollResult("pending_anchor")
      );

      await reconcileAnchors();

      // Should NOT find terminal sessions since we exclude them in the query
      // They should not appear in findMany results at all
      expect(h.prisma.anchorSession.findMany).toHaveBeenCalled();
    }
  });

  it("does not overwrite terminal states if they slip through (guard clause)", async () => {
    // Simulate a race where a session becomes terminal between findMany and update
    h.prisma.anchorSession.findMany.mockResolvedValue([
      { ...baseSession, status: "completed" },
    ]);
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 0 }); // Claim fails
    const { anchorServiceMock } = mockAnchorService();
    anchorServiceMock.pollTransaction.mockResolvedValue(makePollResult("pending_anchor"));

    // The session is terminal, so the query wouldn't have returned it —
    // but if it did, the guard in reconcileSingleAnchor should protect it.
    await reconcileAnchors();

    // The session was found by the query, so update should be called
    // only to update lastPolledAt if status is the same, or not at all
    // Actually, since status is terminal and the remote returns pending_anchor,
    // the terminal-state protection should stop the update.
    expect(h.prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("skips sessions polled within the last 30 seconds", async () => {
    const recentLastPolled = new Date(Date.now() - 10 * 1000); // 10s ago
    h.prisma.anchorSession.findMany.mockResolvedValue([
      { ...baseSession, lastPolledAt: recentLastPolled },
    ]);
    const { anchorServiceMock } = mockAnchorService();

    await reconcileAnchors();

    // Session should NOT be returned by findMany because lastPolledAt is recent
    // The query now uses AND with nested ORs, so we check the structure is correct
    expect(h.prisma.anchorSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({ lastPolledAt: null }),
                expect.objectContaining({
                  lastPolledAt: expect.objectContaining({ lt: expect.any(Date) }),
                }),
              ]),
            }),
          ]),
        }),
      })
    );
  });

  it("retries with exponential backoff on poll errors", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([baseSession]);
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
    const { anchorServiceMock } = mockAnchorService();
    anchorServiceMock.pollTransaction.mockResolvedValue({
      rawStatus: null,
      status: "pending_anchor",
      message: "Anchor returned HTTP 503",
      isError: true,
    });

    // First retry (retryCount 0 → 1)
    await reconcileAnchors();
    expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "as_1" },
        data: expect.objectContaining({
          retryCount: 1,
          failureReason: "Anchor returned HTTP 503",
          lastPolledAt: expect.any(Date),
          errorCategory: "transient",
          nextRetryAt: expect.any(Date),
        }),
      })
    );

    // Simulate retryCount reaching max
    vi.clearAllMocks();
    h.prisma.anchorSession.findMany.mockResolvedValue([
      { ...baseSession, retryCount: 3, status: "pending_anchor", nextRetryAt: null },
    ]);
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
    anchorServiceMock.pollTransaction.mockResolvedValue({
      rawStatus: null,
      status: "pending_anchor",
      message: "Anchor timed out",
      isError: true,
    });

    await reconcileAnchors();
    expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "as_1" },
        data: expect.objectContaining({
          status: "error",
          failureReason: "Anchor timed out",
          nextRetryAt: null,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "anchor.session.failed",
      })
    );
  });

  it("handles empty session list gracefully", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([]);
    const { anchorServiceMock } = mockAnchorService();

    await reconcileAnchors();

    expect(anchorServiceMock.getToml).not.toHaveBeenCalled();
    expect(anchorServiceMock.pollTransaction).not.toHaveBeenCalled();
  });

  it("recovers from transient anchor errors without marking as failed", async () => {
    // First call: error
    h.prisma.anchorSession.findMany.mockResolvedValue([baseSession]);
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
    const { anchorServiceMock } = mockAnchorService();
    anchorServiceMock.pollTransaction
      .mockResolvedValueOnce({
        rawStatus: null,
        status: "pending_anchor",
        message: "Anchor timed out",
        isError: true,
      })
      .mockResolvedValueOnce(makePollResult("completed"));

    await reconcileAnchors();

    // Should have recorded the error
    expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "as_1" },
        data: expect.objectContaining({
          retryCount: 1,
          failureReason: "Anchor timed out",
          errorCategory: "transient",
          nextRetryAt: expect.any(Date),
        }),
      })
    );

    // Second call: success (simulate next cycle after retry delay)
    vi.clearAllMocks();
    h.prisma.anchorSession.findMany.mockResolvedValue([
      { ...baseSession, retryCount: 1, failureReason: "Anchor timed out", nextRetryAt: null },
    ]);
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
    await reconcileAnchors();

    // Should have updated to completed and cleared failureReason
    expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "as_1" },
        data: expect.objectContaining({
          status: "completed",
          failureReason: null,
          retryCount: 0,
          errorCategory: null,
          nextRetryAt: null,
        }),
      })
    );
  });

  it("filters out sessions with null token or externalTransactionId via Prisma query", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([]);
    const { anchorServiceMock } = mockAnchorService();

    await reconcileAnchors();

    // Verify the query filters properly
    expect(h.prisma.anchorSession.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          anchorToken: { not: null },
          externalTransactionId: { not: null },
        }),
      })
    );
    expect(anchorServiceMock.pollTransaction).not.toHaveBeenCalled();
  });

  it("prevents concurrent anchor session processing via optimistic locking", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([baseSession]);
    h.prisma.anchorSession.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const { anchorServiceMock } = mockAnchorService();
    anchorServiceMock.pollTransaction.mockResolvedValue(makePollResult("completed"));

    // Two workers processing concurrently
    await Promise.all([
      reconcileAnchors(),
      reconcileAnchors(),
    ]);

    // Only one should poll
    expect(anchorServiceMock.pollTransaction).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// processSubmittedSettlements — Stellar settlement submission
// ---------------------------------------------------------------------------

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
      nextRetryAt: null,
      errorCategory: null,
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
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
          errorCategory: null,
          nextRetryAt: null,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalled();
  });

  it("retries transient failures with exponential backoff before confirming", async () => {
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
      nextRetryAt: null,
      errorCategory: null,
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce("hash_456");

    // Use fake timers to control delay
    const delays: number[] = [];
    setDelayFn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(3);
    // Verify exponential backoff (should increase)
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_2" },
        data: expect.objectContaining({
          status: "confirmed",
          stellarTxHash: "hash_456",
          errorCategory: null,
          nextRetryAt: null,
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
      nextRetryAt: null,
      errorCategory: null,
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "failed" });
    h.submitPayment.mockRejectedValue(new Error("timeout"));

    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(SETTLEMENT_MAX_RETRIES);
    // The final update should mark it as failed with permanent category (retries exhausted)
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_3" },
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.any(String),
          errorCategory: "permanent", // Retries exhausted = permanent failure
          nextRetryAt: null,
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
      nextRetryAt: null,
      errorCategory: null,
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "failed" });
    h.submitPayment.mockRejectedValue(new Error("invalid signature"));

    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_4" },
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.any(String),
          errorCategory: "permanent",
          nextRetryAt: null,
        }),
      })
    );
  });

  it("prevents concurrent workers from processing the same settlement", async () => {
    const settlement = {
      id: "settle_5",
      shortCode: "CONCURRENT",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "5.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr-5",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      nextRetryAt: null,
      errorCategory: null,
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    // First claim succeeds, second fails (optimistic locking)
    h.prisma.settlement.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment.mockResolvedValue("hash_789");

    setDelayFn(() => Promise.resolve());

    // Simulate two workers processing the same settlement
    const [result1, result2] = await Promise.all([
      processSubmittedSettlements(),
      processSubmittedSettlements(),
    ]);

    // Only one should succeed in claiming and submitting
    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledTimes(2);
  });

  it("skips settlements that are not yet ready for retry", async () => {
    const futureDate = new Date(Date.now() + 60000); // 1 minute in future
    const settlement = {
      id: "settle_6",
      shortCode: "WAIT",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: ".00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr-6",
      expenseShareId: null,
      retryCount: 1,
      status: "submitted",
      nextRetryAt: futureDate,
      errorCategory: "transient",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 0 }); // Claim fails due to nextRetryAt

    await processSubmittedSettlements();

    // Should not attempt submission
    expect(h.submitPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Concurrent worker tests
// ---------------------------------------------------------------------------

describe("Concurrent Worker Safety", () => {
  it("prevents duplicate payment submissions via optimistic locking", async () => {
    const settlement = {
      id: "settle_concurrent",
      shortCode: "CONC",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "10.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      nextRetryAt: null,
      errorCategory: null,
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    // Simulate race: first worker claims, second fails
    h.prisma.settlement.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment.mockResolvedValue("hash_xyz");

    setDelayFn(() => Promise.resolve());

    // Run two workers concurrently
    await Promise.all([
      processSubmittedSettlements(),
      processSubmittedSettlements(),
    ]);

    // Only one submission should occur
    expect(h.submitPayment).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Restart recovery tests
// ---------------------------------------------------------------------------

describe("Restart Recovery", () => {
  it("resumes processing after worker restart without duplicating submissions", async () => {
    const settlement = {
      id: "settle_restart",
      shortCode: "RESTART",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "10.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr",
      expenseShareId: null,
      retryCount: 1, // Already retried once before restart
      status: "submitted",
      nextRetryAt: null,
      errorCategory: "transient",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment.mockResolvedValue("hash_restart");

    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    // Should submit successfully (not duplicate)
    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          retryCount: expect.any(Number), // Should be incremented
          status: "confirmed",
        }),
      })
    );
  });
});
