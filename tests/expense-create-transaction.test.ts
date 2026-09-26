/**
 * Group expense creation is a three-table write — the expense row, the
 * participant split rows, and the `expense.create` audit entry — that must
 * land as one unit (Issue #537).
 *
 * These tests use an in-memory Prisma fake whose `$transaction` implements
 * real BEGIN/COMMIT/ROLLBACK semantics: writes made inside the callback hit
 * the store immediately, and an error restores the pre-transaction snapshot.
 * That lets a failure be injected *after* genuine writes have happened, so
 * the assertions prove the writes were rolled back — not merely that an
 * error was returned while nothing was ever written.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  interface Tables {
    expenses: any[];
    expenseShares: any[];
    auditLogs: any[];
  }

  const tables: Tables = { expenses: [], expenseShares: [], auditLogs: [] };

  const state = {
    /** Throw while inserting the SECOND participant split (after real writes). */
    failShareInsert: false,
    /** Throw while writing the audit entry (after expense + splits were written). */
    failAuditInsert: false,
    /** Attempts vs. successful writes of split rows — survives rollback on purpose. */
    shareInsertAttempts: 0,
    shareRowsWritten: 0,
    /** Expense rows written inside a transaction — proves a write happened then rolled back. */
    expenseRowsWrittenInTx: 0,
    /** >0 while executing inside `$transaction`. */
    txDepth: 0,
    idSeq: 0,
  };

  const users: Record<string, any> = {};
  let membership: Record<string, any> = {};

  const snapshot = (): Tables =>
    structuredClone({
      expenses: tables.expenses,
      expenseShares: tables.expenseShares,
      auditLogs: tables.auditLogs,
    });

  const restore = (snap: Tables): void => {
    tables.expenses.splice(0, tables.expenses.length, ...snap.expenses);
    tables.expenseShares.splice(0, tables.expenseShares.length, ...snap.expenseShares);
    tables.auditLogs.splice(0, tables.auditLogs.length, ...snap.auditLogs);
  };

  const prisma: any = {
    groupMember: {
      findUnique: async ({ where }: any) => {
        const key = `${where.groupId_userId.groupId}:${where.groupId_userId.userId}`;
        return membership[key] ?? null;
      },
      findMany: async ({ where }: any) =>
        (where?.userId?.in ?? []).map((userId: string) => ({
          userId,
          user: users[userId],
        })),
    },
    group: {
      findUnique: async () => null,
    },
    expense: {
      create: async ({ data, include }: any) => {
        const expense = {
          id: `exp_${++state.idSeq}`,
          groupId: data.groupId,
          payerUserId: data.payerUserId,
          title: data.title,
          description: data.description ?? null,
          amount: data.amount,
          assetCode: data.assetCode,
          assetIssuer: data.assetIssuer ?? null,
          splitType: data.splitType,
          memo: data.memo ?? null,
          receiptUrl: data.receiptUrl ?? null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        };
        // The parent row is written first — exactly the window where a later
        // split failure would strand an expense without shares if the whole
        // unit were not transactional.
        tables.expenses.push(expense);
        if (state.txDepth > 0) state.expenseRowsWrittenInTx++;

        const drafts: any[] = data.shares?.create ?? [];
        for (const draft of drafts) {
          state.shareInsertAttempts++;
          // Fail AFTER one split row is already written, so the rollback has
          // both an expense row and a split row to undo.
          if (state.failShareInsert && state.shareInsertAttempts >= 2) {
            const err: any = new Error("split insertion failed (simulated P2003)");
            err.code = "P2003";
            throw err;
          }
          tables.expenseShares.push({
            id: `shr_${++state.idSeq}`,
            expenseId: expense.id,
            userId: draft.userId,
            shareAmount: draft.shareAmount,
            status: draft.status,
          });
          state.shareRowsWritten++;
        }

        const shares = tables.expenseShares
          .filter((share) => share.expenseId === expense.id)
          .map((share) => ({ ...share, user: users[share.userId] }));

        const result: any = { ...expense };
        if (include?.payer) result.payer = users[expense.payerUserId] ?? null;
        if (include?.shares) result.shares = shares;
        return result;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        if (state.failAuditInsert) {
          throw new Error("audit write failed (simulated)");
        }
        const row = { id: `aud_${++state.idSeq}`, ...data };
        tables.auditLogs.push(row);
        return row;
      },
    },
    $transaction: async (arg: any) => {
      const snap = snapshot();
      state.txDepth++;
      try {
        return typeof arg === "function" ? await arg(prisma) : await Promise.all(arg);
      } catch (err) {
        restore(snap);
        throw err;
      } finally {
        state.txDepth--;
      }
    },
    $disconnect: vi.fn(),
  };

  return {
    prisma,
    tables,
    state,
    users,
    setMembership: (rows: Record<string, any>) => {
      membership = rows;
    },
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { createGroupExpense } from "../src/services/expenses";

const GROUP_ID = "group_1";
const USER_1 = "user_1";
const USER_2 = "user_2";

const userOne = {
  id: USER_1,
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1",
  displayName: "Payer",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const userTwo = {
  id: USER_2,
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA2",
  displayName: "Participant",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function authHeader() {
  return {
    authorization: `Bearer ${signToken({
      id: USER_1,
      stellarPublicKey: userOne.stellarPublicKey,
    })}`,
  };
}

const payload = {
  title: "Dinner",
  amount: "40.0000000",
  assetCode: "XLM",
  splitType: "equal",
  shares: [{ userId: USER_1 }, { userId: USER_2 }],
};

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  h.tables.expenses.splice(0);
  h.tables.expenseShares.splice(0);
  h.tables.auditLogs.splice(0);
  Object.assign(h.state, {
    failShareInsert: false,
    failAuditInsert: false,
    shareInsertAttempts: 0,
    shareRowsWritten: 0,
    expenseRowsWrittenInTx: 0,
    txDepth: 0,
    idSeq: 0,
  });
  h.users[USER_1] = userOne;
  h.users[USER_2] = userTwo;
  h.setMembership({
    [`${GROUP_ID}:${USER_1}`]: { groupId: GROUP_ID, userId: USER_1, role: "member" },
    [`${GROUP_ID}:${USER_2}`]: { groupId: GROUP_ID, userId: USER_2, role: "member" },
  });
  if (!app) app = await buildApp();
});

async function createExpense() {
  return app.inject({
    method: "POST",
    url: `/groups/${GROUP_ID}/expenses`,
    headers: authHeader(),
    payload,
  });
}

describe("POST /groups/:id/expenses — transactional creation", () => {
  it("persists the expense, its splits, and the audit entry together on success", async () => {
    const res = await createExpense();

    expect(res.statusCode).toBe(200);
    expect(h.tables.expenses).toHaveLength(1);
    expect(h.tables.expenseShares).toHaveLength(2);
    expect(h.tables.auditLogs).toHaveLength(1);

    const [expense] = h.tables.expenses;
    const payerShare = h.tables.expenseShares.find((s) => s.userId === USER_1);
    const otherShare = h.tables.expenseShares.find((s) => s.userId === USER_2);
    expect(payerShare).toMatchObject({ expenseId: expense.id, status: "settled" });
    expect(otherShare).toMatchObject({ expenseId: expense.id, status: "pending" });

    expect(h.tables.auditLogs[0]).toMatchObject({
      action: "expense.create",
      entityType: "expense",
      entityId: expense.id,
      groupId: GROUP_ID,
      userId: USER_1,
    });
  });

  it("rolls back the expense, the splits, and the audit log when split insertion fails", async () => {
    h.state.failShareInsert = true;

    const res = await createExpense();

    // Not an AppError, so the generic handler surfaces it as a 500.
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe("INTERNAL_ERROR");

    // The failure genuinely happened mid-write: the expense row and one split
    // row were inserted inside the transaction before the second split threw.
    expect(h.state.shareInsertAttempts).toBeGreaterThanOrEqual(2);
    expect(h.state.expenseRowsWrittenInTx).toBe(1);
    expect(h.state.shareRowsWritten).toBe(1);

    // ...and the transaction undid every one of them: nothing is persisted.
    expect(h.tables.expenses).toHaveLength(0);
    expect(h.tables.expenseShares).toHaveLength(0);
    expect(h.tables.auditLogs).toHaveLength(0);
  });

  it("rolls back the expense and splits when the audit write fails", async () => {
    h.state.failAuditInsert = true;

    const res = await createExpense();

    expect(res.statusCode).toBe(500);

    // The audit entry is the LAST write of the unit — by the time it fails the
    // expense row and both split rows already exist, and all must be undone.
    expect(h.state.expenseRowsWrittenInTx).toBe(1);
    expect(h.state.shareRowsWritten).toBe(2);

    expect(h.tables.auditLogs).toHaveLength(0);
    expect(h.tables.expenses).toHaveLength(0);
    expect(h.tables.expenseShares).toHaveLength(0);
  });
});

describe("createGroupExpense — service-level rollback", () => {
  const include = { payer: true, shares: { include: { user: true } } } as const;

  const params = {
    groupId: GROUP_ID,
    payerUserId: USER_1,
    actorUserId: USER_1,
    title: "Taxi",
    description: null,
    amount: "12.0000000",
    assetCode: "XLM",
    assetIssuer: null,
    splitType: "equal",
    memo: "TAXI01",
    receiptUrl: null,
    shares: [
      { userId: USER_1, shareAmount: "6.0000000" },
      { userId: USER_2, shareAmount: "6.0000000" },
    ],
  };

  it("throws and persists nothing when a split insert fails", async () => {
    h.state.failShareInsert = true;

    await expect(createGroupExpense(params, include)).rejects.toThrow(
      /split insertion failed/
    );

    expect(h.state.expenseRowsWrittenInTx).toBe(1);
    expect(h.tables.expenses).toHaveLength(0);
    expect(h.tables.expenseShares).toHaveLength(0);
    expect(h.tables.auditLogs).toHaveLength(0);
  });

  it("commits expense, splits, and audit atomically on success", async () => {
    const created = await createGroupExpense(params, include);

    expect(created.id).toBeDefined();
    expect(h.tables.expenses).toHaveLength(1);
    expect(h.tables.expenseShares).toHaveLength(2);
    expect(h.tables.auditLogs).toHaveLength(1);
    expect(h.tables.auditLogs[0].action).toBe("expense.create");
  });
});
