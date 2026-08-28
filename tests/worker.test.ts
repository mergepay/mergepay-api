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
    hashOf: vi.fn(),
    verifyTransactionMemo: vi.fn(),
    getTransactionPayments: vi.fn(),
    verifyPaymentOperation: vi.fn(),
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
    hashOf: h.hashOf,
  },
}));
vi.mock("../src/services/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/audit")>();
  return { ...actual, audit: h.audit };
});
vi.mock("../src/services/horizonService", () => ({
  verifyTransactionMemo: h.verifyTransactionMemo,
  getTransactionPayments: h.getTransactionPayments,
  verifyPaymentOperation: h.verifyPaymentOperation,
}));
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

import {
  processSubmittedSettlements,
  reconcileAnchors,
  setDelayFn,
  SETTLEMENT_MAX_RETRIES,
  startWorker,
} from "../src/worker/index";
import { startReconciliation } from "../src/worker/reconciliation";
import { anchorService } from "../src/services/anchor";
import { TimeoutError } from "../src/services/timeout";
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
    // Default mocks for horizon verification
    h.verifyTransactionMemo.mockReturnValue(null);
    h.getTransactionPayments.mockResolvedValue([
      {
        id: "op_1",
        type: "payment",
        to: "GTO",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: null,
        amount: "10.00",
      },
    ]);
    h.verifyPaymentOperation.mockReturnValue(null);
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
    // Both failed attempts lost their response, so the worker checks the
    // ledger by envelope hash; nothing is there, so they retry as transient.
    h.hashOf.mockReturnValue("hash_retry");
    h.getTransaction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ successful: true });

    // Use fake timers to control delay
    const delays: number[] = [];
    setDelayFn((ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledTimes(3);
    // Verify exponential backoff (should increase)
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_456");
  });

  it("marks as failed when all retries are exhausted", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(new Error("timeout"));
    h.hashOf.mockReturnValue("hash_exhausted");
    h.getTransaction.mockResolvedValue(null);

    setDelayFn(() => Promise.resolve());

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

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

  it("does not resubmit when the submission response was lost but the transaction already applied", async () => {
    // A timeout means we never learned the outcome. The worker must check
    // Horizon by the envelope's deterministic hash and find the payment
    // already on the ledger — resubmitting would be a double payment.
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(new TimeoutError("Horizon.submit", 30000));
    h.hashOf.mockReturnValue("hash_lost");
    h.getTransaction.mockResolvedValue({ successful: true });

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(h.getTransaction).toHaveBeenCalledWith("hash_lost");
    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_lost");
  });

  it("fails permanently when a lost submission's transaction failed on the ledger", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(new TimeoutError("Horizon.submit", 30000));
    h.hashOf.mockReturnValue("hash_failed");
    h.getTransaction.mockResolvedValue({ successful: false });

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(currentSettlementState?.status).toBe("failed");
    expect(currentSettlementState?.failureReason).toContain("hash_failed");
  });

  it("retries as transient when the ledger has no record of a lost submission", async () => {
    // Horizon has no record of the envelope, so nothing applied and the
    // failure is safe to retry rather than handed to a human.
    setupSettlement({ status: "submitted" });
    h.submitPayment
      .mockRejectedValueOnce(new TimeoutError("Horizon.submit", 30000))
      .mockResolvedValueOnce("hash_retried");
    h.hashOf.mockReturnValue("hash_unknown");
    h.getTransaction
      .mockResolvedValueOnce(null) // alreadyApplied: not on the ledger
      .mockResolvedValueOnce({ successful: true }); // confirmation poll
    setDelayFn(() => Promise.resolve());

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledTimes(2);
    expect(currentSettlementState?.status).toBe("confirmed");
    expect(currentSettlementState?.stellarTxHash).toBe("hash_retried");
  });

  it("persists nextAttemptAt, retryCount, and errorCategory when scheduling a retry", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment
      .mockRejectedValueOnce(new TimeoutError("Horizon.submit", 30000))
      .mockResolvedValueOnce("hash_ok");
    h.hashOf.mockReturnValue("hash_none");
    h.getTransaction
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ successful: true });
    setDelayFn(() => Promise.resolve());

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    const retryUpdate = h.prisma.settlement.update.mock.calls.find(
      (call: any[]) =>
        call[0].data?.nextAttemptAt && call[0].data?.retryCount === 1
    );
    expect(retryUpdate).toBeTruthy();
    expect(retryUpdate![0].data.errorCategory).toBe("transient");
    expect(retryUpdate![0].data.nextAttemptAt).toBeInstanceOf(Date);
    expect((retryUpdate![0].data.nextAttemptAt as Date).getTime()).toBeGreaterThan(
      Date.now() - 1000
    );
    expect(currentSettlementState?.status).toBe("confirmed");
  });

  it("resumes from the persisted retry count after a restart", async () => {
    // A worker restarted after one failed attempt must continue at attempt 2
    // from the persisted retryCount, not reset the budget to 1.
    setupSettlement({ status: "submitted", retryCount: 1 });
    h.submitPayment.mockResolvedValue("hash_after_restart");
    h.getTransaction.mockResolvedValue({ successful: true });

    const promise = processSubmittedSettlements();
    await vi.runAllTimersAsync();
    await promise;

    expect(h.submitPayment).toHaveBeenCalledTimes(1);
    expect(currentSettlementState?.status).toBe("confirmed");
    const attemptUpdate = h.prisma.settlement.update.mock.calls.find(
      (call: any[]) => call[0].data?.retryCount === 2
    );
    expect(attemptUpdate).toBeTruthy();
  });

  it("stores a sanitized failure reason on terminal failure", async () => {
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(
      new Error("op_underfunded: secret=hunter2 xdr=AAAAAgAAAABlongenvelope")
    );
    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    expect(currentSettlementState?.status).toBe("failed");
    expect(currentSettlementState?.failureReason).not.toMatch(/hunter2/);
    expect(currentSettlementState?.failureReason).not.toMatch(/AAAAAgAAAAB/);
    expect(currentSettlementState?.failureReason).toContain("[redacted]");
  });

  it("leaves no dangling timers after retry scheduling completes", async () => {
    // Retry delays are awaited inline and the only worker timer is the single
    // cycle timer in startWorker; a fully processed job must leave nothing
    // scheduled behind it.
    setupSettlement({ status: "submitted" });
    h.submitPayment.mockRejectedValue(new Error("service unavailable"));
    setDelayFn(() => Promise.resolve());

    await processSubmittedSettlements();

    expect(h.submitPayment).toHaveBeenCalledTimes(SETTLEMENT_MAX_RETRIES);
    expect(vi.getTimerCount()).toBe(0);
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

  // Note: the "ambiguous submission outcome" cases (a submitPayment call that
  // errors, e.g. on our own connection timeout, but whose transaction was
  // actually applied to Stellar anyway) are covered above under "does not
  // resubmit when the submission response was lost..." etc., now that the
  // worker's alreadyApplied path (stellar.hashOf + getTransaction) exists.
});

describe("startWorker shutdown", () => {
  it("releases its claims and stops the loop on shutdown", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([]);
    h.prisma.anchorSession.findMany.mockResolvedValue([]);
    const stop = vi.fn();
    vi.mocked(startReconciliation).mockReturnValue(stop);

    const shutdown = await startWorker();
    // Let the first cycle finish and the loop reach its wait point.
    await vi.advanceTimersByTimeAsync(0);
    await shutdown();

    expect(stop).toHaveBeenCalled();
    // Both job families' claims are released so the next worker can pick the
    // work up immediately instead of waiting for the leases to lapse.
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { claimedBy: expect.any(String) } })
    );
    expect(h.prisma.anchorSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { claimedBy: expect.any(String) } })
    );
    // No cycle timer is left behind to keep the process alive.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not claim new jobs once shutdown has begun", async () => {
    h.prisma.settlement.findMany.mockResolvedValue([]);
    const shutdown = await startWorker();
    await vi.advanceTimersByTimeAsync(0);
    await shutdown();

    // A job that becomes eligible after shutdown must not be claimed or
    // submitted — an in-flight shutdown must not start new work.
    const settlement = {
      id: "settle_shutdown",
      shortCode: "SDWN1",
      fromUserId: "user_1",
      toUserId: "user_2",
      amount: "10.00",
      assetCode: "USDC",
      assetIssuer: null,
      transactionXdr: "signed-xdr",
      expenseShareId: null,
      retryCount: 0,
      status: "submitted",
      createdAt: new Date(),
      from: { stellarPublicKey: "GFROM" },
      to: { stellarPublicKey: "GTO" },
    };
    currentSettlementState = { ...settlement };
    h.prisma.settlement.findMany.mockResolvedValue([settlement]);
    h.submitPayment.mockResolvedValue("hash_x");
    h.getTransaction.mockResolvedValue({ successful: true });

    await processSubmittedSettlements();

    expect(h.submitPayment).not.toHaveBeenCalled();
  });
});
