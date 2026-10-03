import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    expense: {
      findFirst: vi.fn(),
    },
    expenseShare: {
      update: vi.fn(),
      count: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    statusHistory: {
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getTransaction: vi.fn(),
    verifyTransactionMemo: vi.fn(),
    getTransactionPayments: vi.fn(),
    verifyPaymentOperation: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: {
    getTransaction: h.getTransaction,
  },
}));
vi.mock("../src/services/audit", () => ({
  audit: h.audit,
  auditTx: vi.fn(),
}));
vi.mock("../src/services/horizonService", () => ({
  verifyTransactionMemo: h.verifyTransactionMemo,
  getTransactionPayments: h.getTransactionPayments,
  verifyPaymentOperation: h.verifyPaymentOperation,
}));

import {
  reconcileSingleSettlement,
  type ReconcilableSettlement,
} from "../src/services/settlement-reconciliation";
import { Errors } from "../src/errors";

function pendingConfirmationSettlement(over: Record<string, any> = {}) {
  return {
    id: "settle_1",
    shortCode: "ABC234",
    groupId: "group_1",
    fromUserId: "user_1",
    toUserId: "user_2",
    amount: "12.5000000",
    assetCode: "XLM",
    assetIssuer: null,
    transactionXdr: "AAAA...",
    stellarTxHash: "abc123def456",
    status: "pending_confirmation",
    retryCount: 0,
    failureReason: null,
    memo: "MP:ABC234",
    expenseId: null,
    expenseShareId: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    from: { stellarPublicKey: "GFROM..." },
    to: { stellarPublicKey: "GTO..." },
    ...over,
  };
}

/** Build the reconcilable settlement params used by reconcileSingleSettlement. */
function makeReconcilable(over: Partial<ReconcilableSettlement> = {}): ReconcilableSettlement {
  return {
    id: "settle_1",
    stellarTxHash: "abc123def456",
    retryCount: 0,
    shortCode: "ABC234",
    amount: "12.5000000",
    assetCode: "XLM",
    assetIssuer: null,
    destinationPublicKey: "GTO...",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.settlement.findMany.mockResolvedValue([]);
  h.prisma.settlement.update.mockResolvedValue({});
  h.prisma.settlement.findUnique.mockResolvedValue({
    id: "settle_1",
    status: "pending_confirmation",
    fromUserId: "user_1",
    expenseShareId: null,
    retryCount: 0,
  });
  h.getTransactionPayments.mockResolvedValue([
    { type: "payment", destination: "GTO...", amount: "12.5000000", asset_type: "native" },
  ]);
  // verifyTransactionMemo returns the memo read from the ledger (#506).
  h.verifyTransactionMemo.mockResolvedValue({
    verified: true,
    memo: "MP:ABC234",
    code: "ABC234",
  });
  h.verifyPaymentOperation.mockImplementation(() => {});
  // Memo → expense validation defaults: no record, so a test that exercises
  // the path must opt in with an explicit mock.
  h.prisma.expense.findFirst.mockResolvedValue(null);
  h.prisma.expenseShare.count.mockResolvedValue(0);
});

// The batch-level reconciliation loop (formerly reconcileSettlements here)
// moved into the worker as reconcilePendingSettlements, where it runs under
// the lease claim — its coverage lives in tests/worker.test.ts.

describe("reconcileSingleSettlement", () => {
  it("resolves a needs_review settlement to confirmed when the hash landed successfully (issue #541)", async () => {
    // A needs_review row carries the same fields the reconciliation needs as
    // a pending_confirmation row: a submitted hash and the stored intent.
    // The reconciliation is identical — only the status the row arrived in
    // differs, which is the worker's candidate query's business, not this
    // function's.
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "needs_review",
      fromUserId: "user_1",
      expenseShareId: "share_9",
      retryCount: 0,
    });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1",
      status: "confirmed",
      expenseShareId: "share_9",
    });
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });

    const outcome = await reconcileSingleSettlement(makeReconcilable(), 10);

    expect(outcome).toBe("confirmed");
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
    // The expense share is settled as part of the confirmation.
    expect(h.prisma.expenseShare.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "share_9" },
        data: { status: "settled" },
      })
    );
  });

  it("resolves a needs_review settlement to failed when the transaction failed on-chain (issue #541)", async () => {
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "needs_review",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });
    h.getTransaction.mockResolvedValue({ successful: false });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });

    const outcome = await reconcileSingleSettlement(makeReconcilable(), 10);

    expect(outcome).toBe("failed");
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  it("moves to completed when transaction is found, successful, and verified", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "confirmed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_abc" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "confirmed",
          retryCount: 0,
          failureReason: null,
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.completed",
        entityId: "settle_1",
        metadata: expect.objectContaining({ stellarTxHash: "hash_abc" }),
      })
    );
  });

  it("moves to failed when transaction is found but was not successful", async () => {
    h.getTransaction.mockResolvedValue({ successful: false });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 2,
    });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_fail", retryCount: 2, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("hash_fail"),
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.failed",
      })
    );
  });

  it("increments retryCount when transaction is not yet visible", async () => {
    h.getTransaction.mockResolvedValue(null);

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_pending", retryCount: 0, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: { retryCount: 1 },
      })
    );
    // Audit not called — just a retry, not a terminal state
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("expires an unresolved settlement after its pending-age threshold", async () => {
    h.getTransaction.mockResolvedValue(null);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "expired", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({
        stellarTxHash: "hash_expired",
        pendingSince: new Date(Date.now() - config.WORKER_PENDING_SETTLEMENT_MAX_AGE_MS - 1),
      }),
      10
    );

    expect(outcome).toBe("expired");
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "expired",
          retryCount: 1,
          failureReason: expect.stringContaining("pending limit expired"),
        }),
      })
    );
  });

  it("fails the settlement when retries are exhausted and tx not visible", async () => {
    h.getTransaction.mockResolvedValue(null);
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 10,
    });

    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: "hash_stale", retryCount: 10, expenseShareId: null },
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("not confirmed"),
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.reconciliation.exhausted",
        metadata: expect.objectContaining({
          attempts: 11,
          maxRetries: 10,
        }),
      })
    );
  });

  it("is a no-op when there is no stellarTxHash", async () => {
    await reconcileSingleSettlement(
      { id: "settle_1", stellarTxHash: null, retryCount: 0, expenseShareId: null },
      10
    );

    expect(h.getTransaction).not.toHaveBeenCalled();
    expect(h.prisma.settlement.update).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("is idempotent — repeated calls for a settled tx return the same result", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "confirmed", expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });

    await reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_abc" }), 10);
    await reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_abc" }), 10);

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledTimes(2);
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// needs_review rows
// ---------------------------------------------------------------------------

// A submission whose on-chain outcome could not be observed is parked in
// needs_review with its hash recorded. The same read-only reconciliation
// applies; the difference is what happens when Horizon still has no answer.
describe("reconcileSingleSettlement — needs_review rows", () => {
  it("demotes a needs_review row to pending_confirmation when Horizon has no answer", async () => {
    h.getTransaction.mockResolvedValue(null);

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({ status: "needs_review", retryCount: 0 }),
      10
    );

    expect(outcome).toBe("pending");
    // The demotion rides the same update as the retry increment — one round
    // trip, and the row never sits in needs_review with a climbing count.
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1" },
        data: expect.objectContaining({
          retryCount: 1,
          status: "pending_confirmation",
        }),
      })
    );
  });

  it("keeps a pending_confirmation row's status when Horizon has no answer", async () => {
    h.getTransaction.mockResolvedValue(null);

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({ status: "pending_confirmation", retryCount: 3 }),
      10
    );

    expect(outcome).toBe("pending");
    expect(h.prisma.settlement.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { retryCount: 4 },
      })
    );
  });

  it("confirms a needs_review row whose transaction landed successfully", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "confirmed", expenseShareId: null,
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "needs_review",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({ status: "needs_review" }),
      10
    );

    expect(outcome).toBe("confirmed");
    // The state machine's conditional guard must list needs_review among the
    // allowed-from statuses — without it the update matches zero rows and the
    // confirmation would silently never land.
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "settle_1",
          status: { in: expect.arrayContaining(["needs_review", "pending_confirmation"]) },
        },
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
  });

  it("fails a needs_review row whose transaction failed on-chain", async () => {
    h.getTransaction.mockResolvedValue({ successful: false });

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({ status: "needs_review" }),
      10
    );

    expect(outcome).toBe("failed");
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "settle_1",
          status: { in: expect.arrayContaining(["needs_review", "pending_confirmation"]) },
        },
        data: expect.objectContaining({ status: "failed" }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "settlement.failed" })
    );
  });
});

// ---------------------------------------------------------------------------
// Verification failure tests
// ---------------------------------------------------------------------------

describe("reconcileSingleSettlement — verification failures", () => {
  it("fails the settlement when memo verification fails", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockRejectedValue(
      new Error("Transaction memo does not match the expected settlement reference")
    );
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_abc" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
        }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        metadata: expect.objectContaining({
          reason: expect.stringContaining("memo"),
        }),
      })
    );
  });

  // Issue #506: memo failures thrown by the real verifier carry messages such
  // as "Transaction has no memo" that match none of the legacy message
  // substrings. They used to be rethrown, which the worker counts as
  // "pending" — leaving the settlement stuck and re-polled every cycle.
  it.each([
    ["missing memo", "Transaction has no memo", "missing_memo"],
    [
      "hash memo",
      'Unexpected memo type: expected "text", got "hash"; a hash memo cannot carry the MP: settlement reference',
      "hash_memo_mismatch",
    ],
    [
      "invalid hash memo",
      'Unexpected memo type: expected "text", got "hash"; the hash memo is malformed (expected 32 bytes, base64-encoded)',
      "invalid_hash_memo",
    ],
    ["id memo", 'Unexpected memo type: expected "text", got "id"', "unsupported_memo_type"],
    [
      "malformed text memo",
      "Transaction memo is not a valid Mergepay reference: Mergepay memo must start with 'MP:'.",
      "malformed_memo",
    ],
  ])("fails (never confirms or rethrows) on a %s", async (_label, message, memoFailure) => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockRejectedValue(
      Errors.badRequest("transaction_verification_failed", message, { memoFailure })
    );
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_bad_memo", expenseId: "exp_1" }),
      10
    );

    expect(outcome).toBe("failed");
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed", failureReason: message }),
      })
    );
    expect(h.prisma.settlement.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "confirmed" }) })
    );
    // No attribution work happens for an unattributable payment.
    expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
    expect(h.getTransactionPayments).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        metadata: expect.objectContaining({ stellarTxHash: "hash_bad_memo", memoFailure }),
      })
    );
  });

  it("fails on a non-payment operation verification error (classified by code)", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyPaymentOperation.mockImplementation(() => {
      throw Errors.badRequest(
        "transaction_verification_failed",
        'Expected a payment operation, got "create_account"'
      );
    });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await expect(
      reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_op" }), 10)
    ).resolves.toBe("failed");
  });

  it("still rethrows unexpected errors so the worker can retry them", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockRejectedValue(new Error("database connection lost"));

    await expect(
      reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_unexpected" }), 10)
    ).rejects.toThrow("database connection lost");
    expect(h.prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("fails the settlement when destination verification fails", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockResolvedValue({ verified: true });
    h.getTransactionPayments.mockResolvedValue([
      { type: "payment", destination: "GWRONG...", amount: "12.5000000", asset_type: "native" },
    ]);
    h.verifyPaymentOperation.mockImplementation(() => {
      throw new Error("Payment destination does not match the expected recipient");
    });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_abc" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      })
    );
  });

  it("fails the settlement when getTransactionPayments throws", async () => {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.verifyTransactionMemo.mockResolvedValue({ verified: true });
    h.getTransactionPayments.mockRejectedValue(
      new Error("Horizon request failed: connection timeout")
    );
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status: "failed", expenseShareId: null
    });

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_payments_error" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          status: "failed",
          failureReason: expect.stringContaining("Horizon"),
        }),
      })
    );
  });
});

// ---------------------------------------------------------------------------
// Memo code vs active expense record (settlement verification worker runs)
// ---------------------------------------------------------------------------

describe("reconcileSingleSettlement — memo code vs active expense record", () => {
  /** Mocks for a transaction that verifies cleanly up to the expense check. */
  function verifiedTransaction(status: "confirmed" | "failed") {
    h.getTransaction.mockResolvedValue({ successful: true });
    h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_1", status, expenseShareId: null
    });
    h.prisma.settlement.findUnique.mockResolvedValue({
      id: "settle_1",
      status: "pending_confirmation",
      fromUserId: "user_1",
      expenseShareId: null,
      retryCount: 0,
    });
  }

  it("confirms only after the parsed memo code resolves to an active expense", async () => {
    verifiedTransaction("confirmed");
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_1", memo: "EXP2345" });
    h.prisma.expenseShare.count.mockResolvedValue(1);

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_ok", expenseId: "exp_1" }),
      10
    );

    // The expected memo is generated from the settlement short code…
    expect(h.verifyTransactionMemo).toHaveBeenCalledWith("hash_ok", "MP:ABC234");
    // …then parsed and resolved against the linked expense record.
    expect(h.prisma.expense.findFirst).toHaveBeenCalledWith({
      where: { id: "exp_1" },
      select: { id: true, memo: true },
    });
    expect(h.prisma.expenseShare.count).toHaveBeenCalledWith({
      where: { expenseId: "exp_1", status: { not: "settled" } },
    });
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
  });

  it("fails the settlement when the linked expense record no longer exists", async () => {
    verifiedTransaction("failed");
    h.prisma.expense.findFirst.mockResolvedValue(null);

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_missing_expense", expenseId: "exp_gone" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({ status: "failed" }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        metadata: expect.objectContaining({
          reason: expect.stringContaining("Memo verification failed"),
        }),
      })
    );
  });

  it("fails the settlement when the memo's expense has no outstanding shares", async () => {
    verifiedTransaction("failed");
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_2", memo: "EXP2345" });
    h.prisma.expenseShare.count.mockResolvedValue(0);

    await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_settled_expense", expenseId: "exp_2" }),
      10
    );

    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      })
    );
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        metadata: expect.objectContaining({
          reason: expect.stringContaining("outstanding shares"),
        }),
      })
    );
  });

  it("resolves the expense from the memo read on-chain, not a rebuilt one", async () => {
    verifiedTransaction("failed");
    // A verifier that (incorrectly) reports success with a different ledger
    // memo must still not confirm: the expense check parses what was paid.
    h.verifyTransactionMemo.mockResolvedValue({
      verified: true,
      memo: "MP:ZZZ999",
      code: "ZZZ999",
    });
    h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_1", memo: "EXP2345" });
    h.prisma.expenseShare.count.mockResolvedValue(1);

    const outcome = await reconcileSingleSettlement(
      makeReconcilable({ stellarTxHash: "hash_swapped", expenseId: "exp_1" }),
      10
    );

    expect(outcome).toBe("failed");
    expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        metadata: expect.objectContaining({
          reason: expect.stringContaining("does not match the expected code"),
        }),
      })
    );
  });

  it("skips the expense lookup for settlements created before expense linking", async () => {
    verifiedTransaction("confirmed");

    await reconcileSingleSettlement(makeReconcilable({ stellarTxHash: "hash_legacy" }), 10);

    expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
  });
});
