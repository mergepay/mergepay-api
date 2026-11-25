/**
 * Issue #1128 — transactional audit logging for group expense settlement failures.
 *
 * `executeGroupSettlement` runs caller-supplied work inside a Prisma transaction
 * and, on failure, records a `SETTLEMENT_FAILED` audit entry via `logActionTx`
 * before re-throwing. The entry is part of the same transaction so it commits or
 * rolls back atomically with the settlement work — no orphan success record, no
 * orphan failure log.
 *
 * These tests verify:
 *   - failed settlement triggers `logActionTx` with the expected params;
 *   - the error is re-thrown after logging, so callers can handle it;
 *   - successful settlement does NOT trigger a failure audit entry;
 *   - failure metadata includes a classified category and a safe reason string.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const fakeTx: any = {
    auditLog: { create: vi.fn(async () => ({})) },
  };

  const prisma: any = {
    $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(fakeTx)),
  };

  return { prisma, fakeTx };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

const logActionTxSpy = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../src/services/audit", () => ({
  logActionTx: logActionTxSpy,
}));

import { executeGroupSettlement } from "../src/services/group-settlement";

const SETTLEMENT_ID = "settlement_test_001";
const GROUP_ID = "group_test_001";
const ACTOR_ID = "user_test_001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("executeGroupSettlement — failure audit logging (#1128)", () => {
  it("logs SETTLEMENT_FAILED via logActionTx when the settlement work throws", async () => {
    const boom = new Error("Horizon timeout");

    await expect(
      executeGroupSettlement(
        { settlementId: SETTLEMENT_ID, groupId: GROUP_ID, actorId: ACTOR_ID },
        async () => { throw boom; }
      )
    ).rejects.toThrow("Horizon timeout");

    expect(logActionTxSpy).toHaveBeenCalledOnce();
    const [, params] = logActionTxSpy.mock.calls[0];
    expect(params.action).toBe("settlement.failed");
    expect(params.resourceType).toBe("settlement");
    expect(params.resourceId).toBe(SETTLEMENT_ID);
    expect(params.groupId).toBe(GROUP_ID);
    expect(params.actorId).toBe(ACTOR_ID);
    expect(params.outcome).toBe("failure");
  });

  it("includes failure category and sanitized reason in metadata", async () => {
    const networkErr = new Error("ECONNRESET: network error");

    await expect(
      executeGroupSettlement(
        { settlementId: SETTLEMENT_ID, groupId: GROUP_ID },
        async () => { throw networkErr; }
      )
    ).rejects.toThrow();

    const [, params] = logActionTxSpy.mock.calls[0];
    expect(params.metadata).toMatchObject({
      category: expect.any(String),
      reason: expect.any(String),
    });
    // Network errors classify as 'upstream'
    expect(params.metadata.category).toBe("upstream");
  });

  it("passes correlationId to the audit entry when provided", async () => {
    const correlationId = "job_settlement_abc123";

    await expect(
      executeGroupSettlement(
        { settlementId: SETTLEMENT_ID, groupId: GROUP_ID, correlationId },
        async () => { throw new Error("fail"); }
      )
    ).rejects.toThrow();

    const [, params] = logActionTxSpy.mock.calls[0];
    expect(params.correlationId).toBe(correlationId);
  });

  it("re-throws the original error after logging so callers can handle it", async () => {
    const original = new Error("ledger rejected");

    const thrown = await executeGroupSettlement(
      { settlementId: SETTLEMENT_ID, groupId: GROUP_ID },
      async () => { throw original; }
    ).catch((e: unknown) => e);

    expect(thrown).toBe(original);
  });

  it("does NOT call logActionTx when the settlement work succeeds", async () => {
    await executeGroupSettlement(
      { settlementId: SETTLEMENT_ID, groupId: GROUP_ID, actorId: ACTOR_ID },
      async () => { /* success — no throw */ }
    );

    expect(logActionTxSpy).not.toHaveBeenCalled();
  });

  it("passes the transaction client to the work callback", async () => {
    const workSpy = vi.fn(async () => {});

    await executeGroupSettlement(
      { settlementId: SETTLEMENT_ID, groupId: GROUP_ID },
      workSpy
    );

    expect(workSpy).toHaveBeenCalledOnce();
    expect(workSpy).toHaveBeenCalledWith(h.fakeTx);
  });

  it("logs without actorId when none is supplied", async () => {
    await expect(
      executeGroupSettlement(
        { settlementId: SETTLEMENT_ID, groupId: GROUP_ID },
        async () => { throw new Error("no actor"); }
      )
    ).rejects.toThrow();

    const [, params] = logActionTxSpy.mock.calls[0];
    expect(params.actorId).toBeNull();
  });
});
