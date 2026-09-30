import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for issue #706 — robust error handling and transaction rollback for
 * multi-step settlement.
 *
 * Three layers are exercised:
 *
 *  1. the settlement machine's own interactive transaction (status + audit +
 *     status history + expense share commit or roll back together);
 *  2. the settlement engine's typed errors (stable codes, client-safe
 *     messages — no bare `Error` objects reaching a response);
 *  3. the worker's terminal-failure path, whose row update, audit record, and
 *     status-history write land inside one interactive transaction so a
 *     partial failure cannot leave them disagreeing.
 *
 * Prisma is replaced with an in-memory double whose `$transaction` gives the
 * callback a scratch layer: writes only become visible to the committed store
 * when the callback resolves, which is exactly the atomicity under test. The
 * transaction-scoped model mocks (`tx.*`) are separate from the top-level
 * ones so a test can fail a specific step *inside* the transaction.
 */

const h = vi.hoisted(() => {
  /** The committed view of the "database". */
  const committed = {
    settlements: {} as Record<string, any>,
    expenseShares: {} as Record<string, any>,
    statusHistory: [] as any[],
    auditLog: [] as any[],
  };

  /** Transaction-scoped mocks a test can program to fail mid-transaction. */
  const txMocks = {
    settlementUpdate: vi.fn(),
    settlementUpdateMany: vi.fn(),
    expenseShareUpdate: vi.fn(),
    statusHistoryCreate: vi.fn(),
    auditLogCreate: vi.fn(),
  };

  const prisma: any = {
    settlement: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    expenseShare: { update: vi.fn() },
    statusHistory: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(),
    $disconnect: vi.fn(),
  };

  return { prisma, committed, txMocks };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { applySettlementTransition } from "../src/services/settlement-machine";
import {
  SETTLEMENT_ENGINE_ERROR_CODES,
  SettlementEngineError,
  assertSupportedSettlementAsset,
  computeShares,
  isSettlementEngineError,
} from "../src/services/settlement";
import { processSettlementJob } from "../src/worker/index";
import type { CorrelationContext } from "../src/lib/correlation";

const prisma = h.prisma;
const committed = h.committed;
const txMocks = h.txMocks;

/**
 * A `$transaction` double with Prisma's interactive-transaction semantics:
 * the callback writes into a scratch layer that is merged into the committed
 * store only on success — a rejection discards every write it made.
 */
beforeEach(() => {
  vi.clearAllMocks();
  committed.settlements = {};
  committed.expenseShares = {};
  committed.statusHistory = [];
  committed.auditLog = [];

  prisma.$transaction.mockImplementation(async (fn: any) => {
    const scratch = {
      settlements: {} as Record<string, any>,
      expenseShares: {} as Record<string, any>,
      statusHistory: [] as any[],
      auditLog: [] as any[],
    };

    const settlementBase = (id: string) =>
      scratch.settlements[id] ?? committed.settlements[id];

    // Defaults push into the scratch layer; a test's mockRejectedValueOnce
    // takes precedence for exactly one call, simulating a mid-transaction
    // failure, after which the default resumes.
    txMocks.settlementUpdate.mockImplementation(async ({ where, data }: any) => {
      const next = { ...(settlementBase(where.id) ?? {}), ...data };
      scratch.settlements[where.id] = next;
      return next;
    });
    txMocks.settlementUpdateMany.mockImplementation(
      async ({ where, data }: any) => {
        const base = settlementBase(where.id);
        if (!base || (where.status?.in && !where.status.in.includes(base.status))) {
          return { count: 0 };
        }
        scratch.settlements[where.id] = { ...base, ...data };
        return { count: 1 };
      }
    );
    txMocks.expenseShareUpdate.mockImplementation(async ({ where, data }: any) => {
      const base =
        scratch.expenseShares[where.id] ?? committed.expenseShares[where.id] ?? {};
      const next = { ...base, ...data };
      scratch.expenseShares[where.id] = next;
      return next;
    });
    txMocks.statusHistoryCreate.mockImplementation(async ({ data }: any) => {
      scratch.statusHistory.push(data);
      return data;
    });
    txMocks.auditLogCreate.mockImplementation(async ({ data }: any) => {
      scratch.auditLog.push(data);
      return data;
    });

    const tx: any = {
      settlement: {
        findUnique: prisma.settlement.findUnique,
        findUniqueOrThrow: prisma.settlement.findUniqueOrThrow,
        update: txMocks.settlementUpdate,
        updateMany: txMocks.settlementUpdateMany,
      },
      expenseShare: { update: txMocks.expenseShareUpdate },
      statusHistory: {
        findFirst: prisma.statusHistory.findFirst,
        create: txMocks.statusHistoryCreate,
      },
      auditLog: { create: txMocks.auditLogCreate },
    };

    try {
      const result = await fn(tx);
      Object.assign(committed.settlements, scratch.settlements);
      Object.assign(committed.expenseShares, scratch.expenseShares);
      committed.statusHistory.push(...scratch.statusHistory);
      committed.auditLog.push(...scratch.auditLog);
      return result;
    } catch (err) {
      // Rollback: nothing written inside the transaction survives.
      void err;
      throw err;
    }
  });
});

const baseSettlement = () => ({
  id: "settle_1",
  groupId: "group_1",
  fromUserId: "user_1",
  toUserId: "user_2",
  amount: "10.00",
  assetCode: "USDC",
  assetIssuer: null,
  status: "verifying",
  retryCount: 0,
  failureReason: null,
  expenseShareId: "share_1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

describe("settlement machine — rollback on partial failure (issue #706)", () => {
  it("commits status, audit, history, and expense share together", async () => {
    committed.settlements["settle_1"] = baseSettlement();
    committed.expenseShares["share_1"] = { id: "share_1", status: "settling" };
    prisma.settlement.findUnique.mockResolvedValue(
      committed.settlements["settle_1"]
    );
    prisma.settlement.findUniqueOrThrow.mockImplementation(async () => ({
      ...baseSettlement(),
      status: "confirmed",
    }));

    const result = await applySettlementTransition({
      settlementId: "settle_1",
      nextStatus: "confirmed",
      source: "worker",
      settleExpenseShare: true,
    });

    expect(result.changed).toBe(true);
    // Every related write is visible in the committed store — none was left
    // behind on a separate, uncommitted connection.
    expect(committed.settlements["settle_1"].status).toBe("confirmed");
    expect(committed.expenseShares["share_1"].status).toBe("settled");
    expect(committed.auditLog).toHaveLength(1);
    expect(committed.statusHistory.map((s) => s.status)).toContain("confirmed");
  });

  it("rolls back status, history, and expense share when the audit write fails", async () => {
    committed.settlements["settle_1"] = baseSettlement();
    committed.expenseShares["share_1"] = { id: "share_1", status: "settling" };
    prisma.settlement.findUnique.mockResolvedValue(
      committed.settlements["settle_1"]
    );
    // The audit write (the step after the status update) fails inside the
    // transaction — every earlier write must be discarded.
    txMocks.auditLogCreate.mockRejectedValueOnce(new Error("audit store down"));

    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "confirmed",
        source: "worker",
        settleExpenseShare: true,
      })
    ).rejects.toThrow("audit store down");

    // Database consistency: the settlement keeps its prior status, the share
    // is not marked settled, and no history row leaked out of the aborted
    // transaction.
    expect(committed.settlements["settle_1"].status).toBe("verifying");
    expect(committed.expenseShares["share_1"].status).toBe("settling");
    expect(committed.statusHistory).toHaveLength(0);
    expect(committed.auditLog).toHaveLength(0);
  });

  it("rolls back when the expense share update fails after the status change", async () => {
    committed.settlements["settle_1"] = baseSettlement();
    committed.expenseShares["share_1"] = { id: "share_1", status: "settling" };
    prisma.settlement.findUnique.mockResolvedValue(
      committed.settlements["settle_1"]
    );
    // The participant allocation fails mid-transaction — the status and audit
    // writes made moments earlier must not survive without it.
    txMocks.expenseShareUpdate.mockRejectedValueOnce(
      new Error("share row locked")
    );

    await expect(
      applySettlementTransition({
        settlementId: "settle_1",
        nextStatus: "confirmed",
        source: "worker",
        settleExpenseShare: true,
      })
    ).rejects.toThrow("share row locked");

    expect(committed.settlements["settle_1"].status).toBe("verifying");
    expect(committed.expenseShares["share_1"].status).toBe("settling");
    expect(committed.auditLog).toHaveLength(0);
    expect(committed.statusHistory).toHaveLength(0);
  });
});

describe("settlement engine — typed, client-safe errors (issue #706)", () => {
  it("carries a stable code for every rejection path", () => {
    const cases: [() => unknown, string][] = [
      [
        () => computeShares("0", "equal", [{ userId: "a" }]),
        SETTLEMENT_ENGINE_ERROR_CODES.INVALID_SPLIT_AMOUNT,
      ],
      [
        () => computeShares("10", "equal", []),
        SETTLEMENT_ENGINE_ERROR_CODES.INVALID_SPLIT_PARTICIPANT,
      ],
      [
        () =>
          computeShares("30", "custom", [
            { userId: "a", amount: "10" },
            { userId: "b", amount: "15" },
          ]),
        SETTLEMENT_ENGINE_ERROR_CODES.INVALID_SPLIT_SUM,
      ],
      [
        () =>
          computeShares("100", "percentage", [
            { userId: "a", percent: 50 },
            { userId: "b", percent: 40 },
          ]),
        SETTLEMENT_ENGINE_ERROR_CODES.INVALID_SPLIT_PERCENT,
      ],
      [
        () => assertSupportedSettlementAsset("BTC", null),
        SETTLEMENT_ENGINE_ERROR_CODES.UNSUPPORTED_ASSET,
      ],
    ];

    for (const [fn, expectedCode] of cases) {
      try {
        fn();
        expect.unreachable(`expected ${expectedCode}`);
      } catch (err) {
        expect(isSettlementEngineError(err)).toBe(true);
        expect((err as SettlementEngineError).code).toBe(expectedCode);
      }
    }
  });

  it("messages name only the request's own fields — never internal state", () => {
    try {
      assertSupportedSettlementAsset("BTC", null);
      expect.unreachable("expected a thrown error");
    } catch (err) {
      expect(isSettlementEngineError(err)).toBe(true);
      const message = (err as SettlementEngineError).message;
      // The asset code came from the request, so echoing it is safe. SQL,
      // connection strings, and stack frames never appear in engine messages
      // because the engine touches none of them.
      expect(message).toContain("BTC");
      expect(message).not.toMatch(/select |insert |postgres:\/\//i);
      expect(message).not.toMatch(/at .+:\d+:\d+/);
    }
  });
});

describe("worker — atomic failure bookkeeping (issue #706)", () => {
  const ctx: CorrelationContext = {
    jobId: "settle_1",
    jobType: "settlement",
    correlationId: "corr_1",
  };

  const workerJob = (over: Record<string, any> = {}) => ({
    id: "settle_1",
    shortCode: "ABC123",
    groupId: "group_1",
    fromPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    toPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    amount: "10.00",
    assetCode: "USDC",
    assetIssuer: null,
    transactionXdr: "signed-xdr",
    expenseShareId: "share_1",
    expiresAt: null,
    retryCount: 0,
    status: "submitted",
    ...over,
  });

  it("commits the failed transition's row, audit, and history together", async () => {
    committed.settlements["settle_1"] = workerJob();
    // The machine's read inside the transaction sees the committed row.
    prisma.settlement.findUnique.mockImplementation(
      async () => committed.settlements["settle_1"]
    );
    // No signed envelope is a permanent validation failure, which drives
    // failSettlement → applySettlementTransition end to end.
    prisma.settlement.findUniqueOrThrow.mockImplementation(
      async () => committed.settlements["settle_1"]
    );

    await processSettlementJob(workerJob({ transactionXdr: null }), ctx);

    // The transition committed: the row, its audit record, and the history
    // entry agree — no orphan writes from a half-finished state machine.
    expect(committed.settlements["settle_1"].status).toBe("failed");
    expect(committed.auditLog.length).toBeGreaterThanOrEqual(1);
    expect(committed.statusHistory.map((s) => s.status)).toContain("failed");
    expect(committed.auditLog[0].action).toBe("settlement.status_changed");
  });

  it("rolls back the whole transition when the audit write fails mid-transaction", async () => {
    committed.settlements["settle_1"] = workerJob({ transactionXdr: null });
    prisma.settlement.findUnique.mockImplementation(
      async () => committed.settlements["settle_1"]
    );
    txMocks.auditLogCreate.mockRejectedValueOnce(new Error("audit store down"));

    // The worker's batch loop is the intended catcher; here the rejection
    // itself is the observable — a database failure must surface, not be
    // swallowed into a silently half-updated row.
    await expect(
      processSettlementJob(workerJob({ transactionXdr: null }), ctx)
    ).rejects.toThrow("audit store down");

    // Rolled back: the row keeps its prior status and nothing leaked.
    expect(committed.settlements["settle_1"].status).toBe("submitted");
    expect(committed.statusHistory).toHaveLength(0);
  });
});
