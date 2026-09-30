/**
 * Issue #506 — memo validation through the real verification pipeline.
 *
 * Runs `reconcileSingleSettlement` with the real `horizonService` and memo
 * library; only the Horizon HTTP client and Prisma are mocked. Proves that a
 * payment whose on-chain memo is missing, malformed, a hash, or for another
 * settlement is failed — never confirmed, never left pending — and that an
 * exact `MP:<shortCode>` memo still confirms.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    settlement: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    expense: { findFirst: vi.fn() },
    expenseShare: { update: vi.fn(), count: vi.fn() },
    auditLog: { create: vi.fn() },
    statusHistory: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getTransaction: vi.fn(),
    horizonTransaction: vi.fn(),
    horizonOperations: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { getTransaction: h.getTransaction },
}));
vi.mock("../src/services/audit", () => ({ audit: h.audit, auditTx: vi.fn() }));
vi.mock("../src/services/webhook", () => ({ dispatchEvent: vi.fn(async () => undefined) }));
vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      ...actual.Horizon,
      Server: vi.fn().mockImplementation(() => ({
        transactions: () => ({ transaction: () => ({ call: h.horizonTransaction }) }),
        operations: () => ({
          forTransaction: () => ({ limit: () => ({ call: h.horizonOperations }) }),
        }),
      })),
    },
  };
});

import { reconcileSingleSettlement } from "../src/services/settlement-reconciliation";

const SHORT_CODE = "ABC234XYZ9";
const DESTINATION = "GDESTINATIONXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

function settlement(over: Record<string, unknown> = {}) {
  return {
    id: "settle_506",
    groupId: "group_1",
    stellarTxHash: "hash_506",
    retryCount: 0,
    shortCode: SHORT_CODE,
    expenseId: "exp_1",
    amount: "12.5000000",
    assetCode: "XLM",
    assetIssuer: null,
    destinationPublicKey: DESTINATION,
    status: "pending_confirmation",
    ...over,
  };
}

function ledgerTx(memo: { memo_type: string; memo?: string }) {
  h.horizonTransaction.mockResolvedValue({
    hash: "hash_506",
    successful: true,
    source_account: "GSOURCE",
    fee_charged: 100,
    operation_count: 1,
    created_at: "2026-09-26T00:00:00Z",
    ...memo,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTransaction.mockResolvedValue({ successful: true });
  h.horizonOperations.mockResolvedValue({
    records: [
      { type: "payment", destination: DESTINATION, amount: "12.5000000", asset_type: "native" },
    ],
  });
  h.prisma.settlement.findUnique.mockResolvedValue({
    id: "settle_506",
    status: "pending_confirmation",
    fromUserId: "user_1",
    expenseShareId: null,
    retryCount: 0,
  });
  h.prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
  h.prisma.expense.findFirst.mockResolvedValue({ id: "exp_1", memo: "EXP2345" });
  h.prisma.expenseShare.count.mockResolvedValue(1);
});

function statusWritten(): string[] {
  return h.prisma.settlement.updateMany.mock.calls.map((c: any[]) => c[0]?.data?.status);
}

describe("settlement memo validation — real verification pipeline (#506)", () => {
  it("confirms a payment carrying exactly MP:<shortCode>", async () => {
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_506", status: "confirmed", expenseShareId: null,
    });
    ledgerTx({ memo_type: "text", memo: `MP:${SHORT_CODE}` });

    await expect(reconcileSingleSettlement(settlement(), 10)).resolves.toBe("confirmed");
    expect(statusWritten()).toEqual(["confirmed"]);
    expect(h.prisma.expense.findFirst).toHaveBeenCalledWith({
      where: { id: "exp_1" },
      select: { id: true, memo: true },
    });
  });

  it.each([
    ["missing memo", { memo_type: "none" }, "missing_memo"],
    ["empty text memo", { memo_type: "text", memo: "" }, "missing_memo"],
    ["lower-cased memo", { memo_type: "text", memo: `mp:${SHORT_CODE.toLowerCase()}` }, "malformed_memo"],
    ["whitespace-padded memo", { memo_type: "text", memo: ` MP:${SHORT_CODE}` }, "malformed_memo"],
    ["free-form memo", { memo_type: "text", memo: "rent september" }, "malformed_memo"],
    ["memo for another settlement", { memo_type: "text", memo: "MP:ZZZ234XYZ9" }, "code_mismatch"],
    ["truncated code", { memo_type: "text", memo: `MP:${SHORT_CODE.slice(0, 6)}` }, "code_mismatch"],
    [
      "well-formed hash memo",
      { memo_type: "hash", memo: Buffer.alloc(32, 3).toString("base64") },
      "hash_memo_mismatch",
    ],
    [
      "hash memo carrying the MP: bytes",
      {
        memo_type: "hash",
        memo: Buffer.concat([Buffer.from(`MP:${SHORT_CODE}`), Buffer.alloc(19)]).toString("base64"),
      },
      "hash_memo_mismatch",
    ],
    ["malformed hash memo", { memo_type: "hash", memo: "zz" }, "invalid_hash_memo"],
    ["id memo", { memo_type: "id", memo: "506" }, "unsupported_memo_type"],
  ])("fails a payment with a %s without attributing it", async (_label, memo, memoFailure) => {
    h.prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      id: "settle_506", status: "failed", expenseShareId: null,
    });
    ledgerTx(memo);

    await expect(reconcileSingleSettlement(settlement(), 10)).resolves.toBe("failed");

    // Terminal failure — not confirmed, not left pending for another cycle.
    expect(statusWritten()).toEqual(["failed"]);
    expect(h.prisma.settlement.update).not.toHaveBeenCalled();
    // Nothing is attributed: no expense lookup, no share settled, no payment check.
    expect(h.prisma.expense.findFirst).not.toHaveBeenCalled();
    expect(h.prisma.expenseShare.update).not.toHaveBeenCalled();
    expect(h.horizonOperations).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "settlement.verification_failed",
        entityId: "settle_506",
        metadata: expect.objectContaining({ memoFailure }),
      })
    );
  });
});
