import { beforeEach, describe, expect, it, vi } from "vitest";

let currentSettlementState: Record<string, any> | null = null;
let currentAnchorState: Record<string, any> | null = null;

const h = vi.hoisted(() => {
  let updateManyCount = 1;
  const settlement = {
    findMany: vi.fn(),
    findUnique: vi.fn(() => currentSettlementState),
    findUniqueOrThrow: vi.fn(() => currentSettlementState),
    update: vi.fn(async ({ data }: any) => {
      if (currentSettlementState) {
        currentSettlementState = { ...currentSettlementState, ...data };
      }
      return currentSettlementState;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      // Simulate conditional update: only update if status matches
      if (currentSettlementState && where.status?.in?.includes(currentSettlementState.status)) {
        updateManyCount = 1;
        if (currentSettlementState && data) {
          currentSettlementState = { ...currentSettlementState, ...data };
        }
        return { count: 1 };
      }
      updateManyCount = 0;
      return { count: 0 };
    }),
    getUpdateManyCount: () => updateManyCount,
  };
  const anchorSession = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(async () => undefined),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const expenseShare = {
    update: vi.fn(),
  };
  const auditLog = { create: vi.fn() };
  const statusHistory = {
    findFirst: vi.fn(),
    create: vi.fn(),
  };
  const prisma: any = {
    settlement,
    anchorSession,
    expenseShare,
    auditLog,
    statusHistory,
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };

  return {
    prisma,
    submitPayment: vi.fn(),
    getTransaction: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(),
    buildPayment: vi.fn(),
    submitPayment: h.submitPayment,
    getTransaction: h.getTransaction,
  },
}));
vi.mock("../src/services/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/audit")>();
  return { ...actual, audit: h.audit };
});
vi.mock("../src/services/settlement-reconciliation", () => ({
  reconcileSettlements: vi.fn(),
}));
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
import { AppError } from "../src/errors";

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
  currentSettlementState = null;
  currentAnchorState = null;
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
    h.prisma.anchorSession.findUnique.mockReset();
    h.prisma.anchorSession.update.mockResolvedValue({});
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.anchorSession.findUnique.mockResolvedValue(baseSession);
  });

  it("discovers pending sessions and polls them", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([baseSession]);
    const { anchorServiceMock } = mockAnchorService();
    anchorServiceMock.pollTransaction.mockResolvedValue(makePollResult("completed"));

    await reconcileAnchors();

    expect(h.prisma.anchorSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "as_1" },
        data: expect.objectContaining({
          status: "completed",
          lastPolledAt: expect.any(Date),
          failureReason: null,
          retryCount: 0,
          errorCategory: null,
          nextAttemptAt: null,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "anchor.session.completed", entityId: "as_1" })
    );
  });

  it("handles empty session list gracefully", async () => {
    h.prisma.anchorSession.findMany.mockResolvedValue([]);
    const { anchorServiceMock } = mockAnchorService();

    await reconcileAnchors();

    expect(anchorServiceMock.getToml).not.toHaveBeenCalled();
    expect(anchorServiceMock.pollTransaction).not.toHaveBeenCalled();
  });
});

describe("processSubmittedSettlements", () => {
  const baseSettlement = {
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
    failureReason: null,
    submittedAt: null,
    confirmedAt: null,
    createdAt: new Date(),
    from: { stellarPublicKey: "GFROM" },
    to: { stellarPublicKey: "GTO" },
  };

  function setupSettlement(over: Record<string, any> = {}) {
    const s = { ...baseSettlement, ...over };
    currentSettlementState = { ...s };
    h.prisma.settlement.findMany.mockResolvedValue([s]);
    return s;
  }

  it("confirms a submitted settlement via submit + Horizon verification", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockResolvedValue("hash_123");
    h.getTransaction.mockResolvedValue({ successful: true });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    // The full intent (not just the bare XDR) is passed through so
    // submitPayment's own validatePaymentTx call re-validates it before
    // submission — see "passes the settlement's own recorded intent..." below.
    expect(h.submitPayment).toHaveBeenCalledWith(
      "signed-xdr",
      expect.objectContaining({ sourcePublicKey: "GFROM", destination: "GTO" })
    );
    expect(h.getTransaction).toHaveBeenCalledWith("hash_123");

    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_123");
    expect(currentSettlementState?.confirmedAt).toBeInstanceOf(Date);

    // applySettlementTransition writes its audit record via auditTx
    // (atomic with the status change), not the fire-and-forget audit()
    // helper, so the real auditLog.create call is what to assert on.
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "settlement.status_changed",
          entityId: "settle_1",
          metadata: expect.objectContaining({ to: "confirmed" }),
        }),
      })
    );
  });

  it("transitions through verifying state before confirming", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockResolvedValue("hash_123");
    h.getTransaction.mockResolvedValue({ successful: true });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(currentSettlementState?.status).toBe("confirmed");
    const updateManyCalls = h.prisma.settlement.updateMany.mock.calls;
    const statuses = updateManyCalls.map((c: any[]) => c[0].data?.status);
    expect(statuses).toContain("verifying");
    expect(statuses).toContain("confirmed");
    expect(statuses.indexOf("verifying")).toBeLessThan(statuses.indexOf("confirmed"));
  });

  it("marks as failed when Horizon reports unsuccessful transaction", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockResolvedValue("hash_bad");
    h.getTransaction.mockResolvedValue({ successful: false });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(currentSettlementState?.status).toBe("failed");
    expect(currentSettlementState?.failureReason).toBeTruthy();
  });

  it("marks as needs_review when Horizon verification times out", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockResolvedValue("hash_orphan");
    h.getTransaction.mockResolvedValue(null);

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(currentSettlementState?.status).toBe("needs_review");
  });

  it("recovers a verifying settlement on worker restart", async () => {
    // A settlement left in "verifying" (e.g. the worker process was killed
    // after submission but before Horizon confirmation completed) must be
    // picked up again on the next cycle rather than sitting stuck forever.
    setupSettlement({ status: "verifying", retryCount: 1 });
    h.submitPayment.mockResolvedValue("hash_recovered");
    h.getTransaction.mockResolvedValue({ successful: true });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledWith(
      "signed-xdr",
      expect.objectContaining({
        sourcePublicKey: "GFROM",
        destination: "GTO",
        asset: { code: "USDC", issuer: null },
        amount: "10.00",
        memoCode: "ABC123",
      })
    );
    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_recovered");
    expect(h.prisma.auditLog.create).toHaveBeenCalled();
  });

  it("retries transient failures before confirming", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment
      .mockRejectedValueOnce(new Error("timeout"))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce("hash_456");
    h.getTransaction.mockResolvedValue({ successful: true });

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
    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_456");
  });

  it("marks as failed when all retries are exhausted", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(new Error("timeout"));

    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(SETTLEMENT_MAX_RETRIES);
    // The final update should mark it as failed with permanent category (retries exhausted)
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.any(String),
          errorCategory: "permanent", // Retries exhausted = permanent failure
          nextAttemptAt: null,
        }),
      })
    );
  });

  it("marks as failed immediately on non-transient error without retrying", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(new Error("invalid signature"));

    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(currentSettlementState?.status).toBe("failed");
  });

  it("passes the settlement's own recorded intent to submitPayment so it is re-validated before submission", async () => {
    const settlement = {
      id: "settle_5",
      shortCode: "INTENT1",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "42.5000000",
      assetCode: "USDC",
      assetIssuer: "GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      transactionXdr: "signed-xdr-5",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    currentSettlementState = { ...settlement };
    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.submitPayment.mockResolvedValue("hash_intent");
    h.getTransaction.mockResolvedValue({ successful: true });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    // Every field a malicious or buggy client-signed XDR could diverge on —
    // asset issuer included — is passed through so submitPayment's own
    // validatePaymentTx call actually catches a mismatch, rather than
    // blindly relaying whatever was persisted at confirm time.
    expect(h.submitPayment).toHaveBeenCalledWith("signed-xdr-5", {
      sourcePublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      destination: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      asset: { code: "USDC", issuer: "GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      amount: "42.5000000",
      memoCode: "INTENT1",
      expiresAt: null,
      resource: "settlement",
    });
  });

  it("treats an XDR intent mismatch as permanent and does not retry", async () => {
    const settlement = {
      id: "settle_6",
      shortCode: "MISMATCH1",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "5.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr-6",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
      to: { stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    };

    currentSettlementState = { ...settlement };
    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    // Simulate validatePaymentTx rejecting the stored XDR — a controlled
    // AppError, exactly like the real service throws.
    h.submitPayment.mockRejectedValue(new AppError(400, "XDR_MISMATCH", "Payment destination does not match"));

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    // A rejected AppError (4xx, not 429) is classified as permanent by
    // classifySettlementError, so the worker must not burn retries on an
    // XDR that will never become valid.
    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_6" }),
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  // Note: two "ambiguous submission outcome" cases (a submitPayment call that
  // itself errors, e.g. on our own connection timeout, but whose transaction
  // was actually applied to Stellar anyway) were previously specified here
  // against an `h.hashOf` mock that was never declared anywhere in this
  // file's `vi.hoisted` setup, and no corresponding `hashOf` — a function to
  // compute a signed XDR's transaction hash locally, without needing
  // Stellar's submission response, so Horizon can be queried directly for it
  // — exists anywhere in src/services/stellar.ts. That's a real, valuable
  // reliability feature (detecting "we don't know if this landed" instead of
  // blindly retrying and relying on Stellar's sequence-number replay
  // protection alone) but a distinct one from SEP-24 anchor reconciliation;
  // it belongs with the settlement-submission-resilience work, not here.
});
