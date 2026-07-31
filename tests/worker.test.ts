import { beforeEach, describe, expect, it, vi } from "vitest";

let currentSettlementState: Record<string, any> | null = null;
let currentAnchorState: Record<string, any> | null = null;

const h = vi.hoisted(() => {
  const settlement = {
    findMany: vi.fn(),
    findUnique: vi.fn(() => currentSettlementState),
    update: vi.fn(({ data }: any) => {
      if (currentSettlementState) {
        currentSettlementState = { ...currentSettlementState, ...data };
      }
      return currentSettlementState;
    }),
    updateMany: vi.fn(() => ({ count: 1 })),
  };
  const anchorSession = {
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  };
  const auditLog = { create: vi.fn() };
  const prisma: any = {
    settlement,
    anchorSession,
    auditLog,
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
vi.mock("../src/services/audit", () => ({ audit: h.audit }));
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
    h.prisma.anchorSession.update.mockResolvedValue({});
    h.prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });
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
          nextRetryAt: null,
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

    expect(h.submitPayment).toHaveBeenCalledWith("signed-xdr");
    expect(h.getTransaction).toHaveBeenCalledWith("hash_123");

    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_123");
    expect(currentSettlementState?.confirmedAt).toBeInstanceOf(Date);

    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.status_changed",
        entityId: "settle_1",
        metadata: expect.objectContaining({ to: "confirmed" }),
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
    const updateCalls = h.prisma.settlement.update.mock.calls;
    const statuses = updateCalls.map((c: any[]) => c[0].data.status);
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
    setupSettlement({ status: "verifying", retryCount: 1 });
    h.submitPayment.mockResolvedValue("hash_recovered");
    h.getTransaction.mockResolvedValue({ successful: true });

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
          status: "pending_confirmation",
          stellarTxHash: "hash_123",
          retryCount: 0,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalled();
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
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_2" },
        data: expect.objectContaining({
          status: "pending_confirmation",
          stellarTxHash: "hash_456",
          retryCount: 0,
        }),
      })
    );
  });

  it("marks as failed when all retries are exhausted", async () => {
    setupSettlement({ status: "submitted" });
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

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.prisma.settlement.update.mockResolvedValue({ ...settlement, status: "confirmed" });
    h.submitPayment.mockResolvedValue("hash_intent");

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

    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    // Simulate validatePaymentTx rejecting the stored XDR — a controlled
    // AppError, exactly like the real service throws.
    h.submitPayment.mockRejectedValue(new AppError(400, "XDR_MISMATCH", "Payment destination does not match"));

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    // A rejected AppError (4xx, not 429) is classified as permanent by
    // isPermanentSettlementFailure, so the worker must not burn retries on
    // an XDR that will never become valid.
    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_6" },
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });
});
