/**
 * Audit logging for state-changing group / expense / settlement actions (#633).
 *
 * Prisma is replaced by a small in-memory store whose `$transaction` only
 * commits a callback's writes when the callback resolves, so these tests can
 * assert the real property we care about: a business row and its audit row are
 * either both persisted or neither is.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  type Row = Record<string, any>;
  const tables = ["group", "expense", "settlement", "auditLog", "statusHistory"] as const;
  type Table = (typeof tables)[number];

  const committed: Record<Table, Row[]> = {
    group: [],
    expense: [],
    settlement: [],
    auditLog: [],
    statusHistory: [],
  };

  // Hooks a test can set to make a specific write fail.
  const failures: Partial<Record<Table, Error>> = {};
  // Canned rows returned by create() for tables the serializers need in full.
  const returns: Partial<Record<Table, Row>> = {};

  const stellar = {
    loadAccount: vi.fn(async () => ({
      exists: true,
      sequence: "1",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    })),
    buildPayment: vi.fn(() => "unsigned-xdr"),
  };

  const groupMember = { findUnique: vi.fn(), findMany: vi.fn() };
  const expenseLookups = { findUnique: vi.fn() };
  const expenseShare = { findUnique: vi.fn(), update: vi.fn(async () => ({})) };

  function client(staged: Record<Table, Row[]>): any {
    const model = (table: Table) => ({
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (failures[table]) throw failures[table];
        const row = { id: `${table}_${staged[table].length + 1}`, ...data, ...(returns[table] ?? {}) };
        staged[table].push(row);
        return row;
      }),
      findFirst: vi.fn(async () => null),
    });
    return {
      group: { ...model("group"), findUnique: vi.fn(async () => ({ id: "group_1" })) },
      expense: { ...model("expense"), ...expenseLookups },
      settlement: model("settlement"),
      auditLog: model("auditLog"),
      statusHistory: model("statusHistory"),
      groupMember,
      expenseShare,
    };
  }

  const prisma: any = {
    ...client(committed),
    $transaction: vi.fn(async (fn: (tx: any) => Promise<unknown>) => {
      const staged = Object.fromEntries(tables.map((t) => [t, [] as Row[]])) as Record<Table, Row[]>;
      const result = await fn(client(staged));
      for (const t of tables) committed[t].push(...staged[t]);
      return result;
    }),
    $disconnect: vi.fn(),
  };

  return { prisma, committed, failures, returns, stellar, groupMember, expenseLookups, expenseShare, tables };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: h.stellar,
  memoText: (code: string) => `MP:${code}`,
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const actor = {
  id: "user_1",
  stellarPublicKey: "GACTORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Actor",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};
const payer = { ...actor, id: "payer_1", displayName: "Payer" };

const auth = () => ({
  authorization: `Bearer ${signToken({ id: actor.id, stellarPublicKey: actor.stellarPublicKey })}`,
});

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  for (const t of h.tables) h.committed[t].length = 0;
  for (const k of Object.keys(h.failures)) delete (h.failures as any)[k];
  for (const k of Object.keys(h.returns)) delete (h.returns as any)[k];
  h.groupMember.findUnique.mockResolvedValue({ groupId: "group_1", userId: actor.id, role: "member", user: payer });
  h.groupMember.findMany.mockResolvedValue([{ userId: actor.id }, { userId: payer.id }]);
  h.stellar.loadAccount.mockResolvedValue({
    exists: true,
    sequence: "1",
    balances: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
  });
  if (!app) app = await buildApp();
});

describe("POST /groups", () => {
  beforeEach(() => {
    h.returns.group = {
      id: "group_new",
      description: null,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    };
  });

  it("records the authenticated actor, action, target and group", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(),
      payload: { name: "Trip" },
    });

    expect(res.statusCode).toBe(200);
    expect(h.committed.group).toHaveLength(1);
    expect(h.committed.auditLog).toEqual([
      expect.objectContaining({
        userId: actor.id,
        groupId: "group_new",
        action: "group.create",
        entityType: "group",
        entityId: "group_new",
        metadata: { name: "Trip", outcome: "success", actorType: "user" },
      }),
    ]);
  });

  it("persists neither the group nor the audit entry when the audit write fails", async () => {
    h.failures.auditLog = new Error("audit table unavailable");

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(),
      payload: { name: "Trip" },
    });

    expect(res.statusCode).toBe(500);
    expect(h.committed.group).toEqual([]);
    expect(h.committed.auditLog).toEqual([]);
  });
});

describe("POST /groups/:id/expenses", () => {
  const payload = {
    title: "Dinner",
    amount: "100",
    assetCode: "XLM",
    splitType: "equal",
    // A client-chosen payer must not become the audit actor.
    payerUserId: payer.id,
    shares: [{ userId: actor.id }, { userId: payer.id }],
  };

  beforeEach(() => {
    h.returns.expense = {
      id: "expense_new",
      description: null,
      receiptUrl: null,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
      payer,
      shares: [],
    };
  });

  it("records the authenticated actor and the expense details", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/expenses",
      headers: auth(),
      payload,
    });

    expect(res.statusCode).toBe(200);
    expect(h.committed.expense).toHaveLength(1);
    expect(h.committed.auditLog).toEqual([
      expect.objectContaining({
        userId: actor.id,
        groupId: "group_1",
        action: "expense.create",
        entityType: "expense",
        entityId: "expense_new",
        metadata: {
          groupId: "group_1",
          amount: "100",
          assetCode: "XLM",
          assetIssuer: null,
          payerUserId: payer.id,
          splitType: "equal",
          shareCount: 2,
          outcome: "success",
          actorType: "user",
        },
      }),
    ]);
  });

  it("persists neither the expense nor the audit entry when the audit write fails", async () => {
    h.failures.auditLog = new Error("audit table unavailable");

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/expenses",
      headers: auth(),
      payload,
    });

    expect(res.statusCode).toBe(500);
    expect(h.committed.expense).toEqual([]);
    expect(h.committed.auditLog).toEqual([]);
  });

  it("writes no audit entry when the caller is not a group member", async () => {
    h.groupMember.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/expenses",
      headers: auth(),
      payload,
    });

    expect(res.statusCode).toBe(403);
    expect(h.committed.auditLog).toEqual([]);
  });
});

describe("settlement creation", () => {
  const settlementRow = {
    id: "settlement_new",
    shortCode: "ABC123",
    stellarTxHash: null,
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    from: actor,
    to: payer,
  };

  beforeEach(() => {
    h.returns.settlement = settlementRow;
    h.expenseLookups.findUnique.mockResolvedValue({
      id: "expense_1",
      groupId: "group_1",
      payerUserId: payer.id,
      assetCode: "XLM",
      assetIssuer: null,
      payer,
      shares: [
        { id: "share_1", userId: actor.id, shareAmount: "25", status: "pending" },
        { id: "share_2", userId: payer.id, shareAmount: "25", status: "settled" },
      ],
    });
    h.expenseShare.findUnique.mockResolvedValue({ id: "share_1", status: "pending" });
  });

  it("POST /expenses/:id/settle audits the settlement against the share", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(h.committed.settlement).toHaveLength(1);
    expect(h.committed.auditLog).toEqual([
      expect.objectContaining({
        userId: actor.id,
        groupId: "group_1",
        action: "settlement.created",
        entityType: "settlement",
        entityId: "settlement_new",
        metadata: expect.objectContaining({
          kind: "expense_share",
          expenseId: "expense_1",
          expenseShareId: "share_1",
          toUserId: payer.id,
          amount: "25",
          assetCode: "XLM",
        }),
      }),
    ]);
  });

  it("POST /groups/:id/settlements audits a net-balance settlement", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: auth(),
      payload: { toUserId: payer.id, amount: "12.5", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(200);
    expect(h.committed.auditLog).toEqual([
      expect.objectContaining({
        userId: actor.id,
        groupId: "group_1",
        action: "settlement.created",
        entityId: "settlement_new",
        metadata: expect.objectContaining({ kind: "net_balance", toUserId: payer.id, amount: "12.5" }),
      }),
    ]);
  });

  it("rolls back both the settlement and its audit entry when the XDR cannot be built", async () => {
    h.stellar.loadAccount.mockResolvedValue({
      exists: false,
      sequence: "0",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: auth(),
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("ACCOUNT_UNFUNDED");
    expect(h.committed.settlement).toEqual([]);
    expect(h.committed.auditLog).toEqual([]);
  });

  it("does not leak signed or unsigned XDR into audit metadata", async () => {
    await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: auth(),
      payload: {},
    });

    expect(JSON.stringify(h.committed.auditLog)).not.toContain("unsigned-xdr");
  });
});
