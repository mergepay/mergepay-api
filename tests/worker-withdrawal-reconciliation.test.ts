/**
 * SEP-24 withdrawal status tracking via worker polling (Issue #508).
 *
 * The deposit side polls every open AnchorSession; these tests cover its
 * mirror for the simpler `Withdrawal` record (POST /withdraw): each cycle
 * polls the anchor with the JWT persisted at confirm time, maps the reported
 * SEP-24 state onto the Withdrawal vocabulary, and persists a transition
 * through applyWithdrawalTransition (guarded update + audit in one
 * transaction).
 *
 * The failure cases matter as much as the happy paths: a poll that times
 * out, hits an unreachable anchor, or returns malformed JSON must leave the
 * row untouched — status, failureReason, and audit log all unchanged.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const withdrawal = {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
  };
  const prisma: any = {
    withdrawal,
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return {
    prisma,
    getToml: vi.fn(),
    pollTransaction: vi.fn(),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: { loadAccount: vi.fn(), buildPayment: vi.fn(), submitPayment: vi.fn() },
}));
vi.mock("../src/worker/reconciliation", () => ({
  runReconciliation: vi.fn(),
  startReconciliation: vi.fn(() => () => {}),
}));
// Partial mock: only the anchor-facing calls are replaced. mapAnchorStatus
// comes from the real module because the worker reads it at import time and
// its mapping is part of the behaviour under test.
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

import { reconcileWithdrawals } from "../src/worker/index";

const prisma = h.prisma;

function fakeWithdrawal(over: Record<string, any> = {}) {
  return {
    id: "wth_1",
    userId: "user_1",
    status: "processing",
    anchorTxId: "ANCH-TX-1",
    anchorToken: "anchor-jwt",
    failureReason: null,
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...over,
  };
}

/** A normalized, successful PollResult as anchorService.pollTransaction returns it. */
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

describe("reconcileWithdrawals — selection", () => {
  it("polls only processing withdrawals that carry an anchor tx id and token", async () => {
    prisma.withdrawal.findMany.mockResolvedValue([]);

    await reconcileWithdrawals();

    expect(prisma.withdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "processing",
          anchorTxId: { not: null },
          anchorToken: { not: null },
        },
      })
    );
    // Nothing to poll, so the anchor is not even contacted.
    expect(h.getToml).not.toHaveBeenCalled();
    expect(h.pollTransaction).not.toHaveBeenCalled();
  });

  it("does not re-poll once a later cycle sees no eligible rows", async () => {
    prisma.withdrawal.findMany
      .mockResolvedValueOnce([fakeWithdrawal()])
      .mockResolvedValueOnce([]);
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal());
    h.pollTransaction.mockResolvedValue(pollResult("completed"));

    await reconcileWithdrawals();
    await reconcileWithdrawals();

    expect(h.pollTransaction).toHaveBeenCalledTimes(1);
    // The completed row is excluded by the status filter on the next cycle,
    // so a terminal withdrawal is never contacted again.
    expect(prisma.withdrawal.findMany).toHaveBeenCalledTimes(2);
  });
});

describe("reconcileWithdrawals — status transitions", () => {
  beforeEach(() => {
    prisma.withdrawal.findMany.mockResolvedValue([fakeWithdrawal()]);
    prisma.withdrawal.findUnique.mockResolvedValue(fakeWithdrawal());
  });

  it("advances to completed when the anchor reports completed", async () => {
    h.pollTransaction.mockResolvedValue(pollResult("completed"));

    await reconcileWithdrawals();

    expect(h.pollTransaction).toHaveBeenCalledWith({
      transferServer: "https://anchor.test/sep24",
      token: "anchor-jwt",
      id: "ANCH-TX-1",
    });
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_1", status: "processing" },
      data: { status: "completed" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "withdrawal.status_changed",
        entityType: "withdrawal",
        entityId: "wth_1",
        metadata: { from: "processing", to: "completed", source: "poll" },
      }),
    });
  });

  it("collapses an anchor error status onto failed, with an audit record", async () => {
    h.pollTransaction.mockResolvedValue(pollResult("error"));

    await reconcileWithdrawals();

    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_1", status: "processing" },
      data: { status: "failed" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "withdrawal.status_changed",
        metadata: { from: "processing", to: "failed", source: "poll" },
      }),
    });
  });

  it.each(["expired", "refunded"] as const)(
    "persists the terminal state %s when the anchor reports it",
    async (rawStatus) => {
      h.pollTransaction.mockResolvedValue(pollResult(rawStatus));

      await reconcileWithdrawals();

      expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
        where: { id: "wth_1", status: "processing" },
        data: { status: rawStatus },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    }
  );

  it("keeps processing when the anchor reports an in-flight status", async () => {
    h.pollTransaction.mockResolvedValue(pollResult("pending_external"));

    await reconcileWithdrawals();

    expect(h.pollTransaction).toHaveBeenCalled();
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("keeps processing when the anchor reports an unrecognized status", async () => {
    // Unknown raw statuses normalize to pending_anchor → processing, which
    // equals the current status: nothing persisted, nothing audited, and the
    // row keeps being polled.
    h.pollTransaction.mockResolvedValue(
      pollResult("pending_anchor", { rawStatus: "pending_something_new", recognized: false })
    );

    await reconcileWithdrawals();

    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("reconcileWithdrawals — anchor failures never corrupt the row", () => {
  beforeEach(() => {
    prisma.withdrawal.findMany.mockResolvedValue([fakeWithdrawal()]);
  });

  it.each([
    ["a transient network failure", { isError: true, category: "unavailable", errorCategory: "transient", message: "connect ETIMEDOUT", status: "pending_anchor" }],
    ["an unreachable anchor", { isError: true, category: "unavailable", errorCategory: "transient", message: "Anchor returned HTTP 503", status: "pending_anchor" }],
    ["a malformed JSON response", { isError: true, category: "malformed", errorCategory: "permanent", message: "Anchor returned malformed (non-JSON) response", status: "pending_anchor" }],
    ["an invalid schema in the response", { isError: true, category: "malformed", errorCategory: "permanent", message: "Anchor returned invalid or malformed response: missing transaction status", status: "pending_anchor" }],
  ])("leaves the withdrawal untouched on %s", async (_label, failure) => {
    h.pollTransaction.mockResolvedValue({ rawStatus: null, ...failure });

    await expect(reconcileWithdrawals()).resolves.not.toThrow();

    // No status change, no failureReason rewrite, no audit noise — the row
    // stays `processing` and the next cycle simply polls again.
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("continues with the remaining withdrawals when one poll throws", async () => {
    const first = fakeWithdrawal({ id: "wth_1", anchorTxId: "ANCH-1" });
    const second = fakeWithdrawal({ id: "wth_2", anchorTxId: "ANCH-2" });
    prisma.withdrawal.findMany.mockResolvedValue([first, second]);
    prisma.withdrawal.findUnique.mockResolvedValue(second);
    h.pollTransaction
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(pollResult("completed"));

    await expect(reconcileWithdrawals()).resolves.not.toThrow();

    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_2", status: "processing" },
      data: { status: "completed" },
    });
  });

  it("skips the whole cycle when the anchor TOML cannot be fetched", async () => {
    h.getToml.mockRejectedValue(new Error("anchor unreachable"));

    await expect(reconcileWithdrawals()).resolves.not.toThrow();

    expect(h.pollTransaction).not.toHaveBeenCalled();
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
    expect(prisma.withdrawal.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
