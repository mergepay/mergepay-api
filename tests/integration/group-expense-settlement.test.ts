/**
 * Group expenses and settlement calculations against a real PostgreSQL 16
 * database.
 *
 * The suite drives the production Fastify routes with `app.inject`, so every
 * assertion sits on the same path as an HTTP request: authentication ->
 * membership/role check -> Zod validation -> service -> Prisma. Only Horizon is
 * stubbed (account load), which lets the unsigned XDR be built by the real
 * `stellar.buildPayment` without touching the network.
 *
 * These tests are intentionally not part of `npm test`; they need a database.
 * Run them with `npm run test:integration`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";

/**
 * Horizon is the only network dependency in the flow under test. The account
 * snapshot is deliberately well funded so settlement preflight passes; the
 * sequence number is stable because nothing is submitted.
 */
vi.mock("../../src/services/stellar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async (publicKey: string) => ({
        exists: true,
        sequence: "410244480000000000",
        balances: [
          { assetCode: "XLM", assetIssuer: null, balance: "10000.0000000" },
          {
            assetCode: "USDC",
            assetIssuer: process.env.STABLE_ASSET_ISSUER ?? null,
            balance: "10000.0000000",
          },
        ],
        signers: [{ key: publicKey, weight: 1 }],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { prisma } from "../../src/db";
import { loadGroupBalancesWithSuggestions } from "../../src/services/group-balances";
import {
  authHeaders,
  cleanupSeededData,
  createExpenseViaApi,
  createGroupWithMembers,
  seedUser,
  type SeededUser,
  type SerializedExpense,
} from "./db-helpers";

interface GroupDetailResponse {
  group: { id: string; name: string };
  members: Array<{ userId: string; role: string }>;
  yourRole: string;
}

interface BalanceResponse {
  balances: Array<{ userId: string; net: string; assetCode: string }>;
  suggestions: Array<{
    fromUserId: string;
    toUserId: string;
    amount: string;
    assetCode: string;
    assetIssuer: string | null;
  }>;
}

interface SettlementOperation {
  fromUserId: string;
  toUserId: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
}

interface PreviewResponse {
  assetCode: string;
  assetIssuer: string | null;
  operations: SettlementOperation[];
}

interface SerializedSettlement {
  id: string;
  groupId: string;
  fromUserId: string;
  toUserId: string;
  amount: string;
  assetCode: string;
  assetIssuer: string | null;
  status: string;
  memo: string | null;
  expenseId: string | null;
  expiresAt: string | null;
}

interface SettlementCreationResponse {
  settlement: SerializedSettlement;
  xdr: string;
  networkPassphrase: string;
  expiresAt: string;
  expiresInSeconds: number;
}

const STROOPS_PER_UNIT = 10_000_000;

let app: FastifyInstance;
let admin: SeededUser;
let member1: SeededUser;
let member2: SeededUser;
let member3: SeededUser;

function uniqueName(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function stroops(amount: string): number {
  return Math.round(Number(amount) * STROOPS_PER_UNIT);
}

function netMap(balances: Array<{ userId: string; net: string }>): Map<string, string> {
  return new Map(balances.map((balance) => [balance.userId, balance.net]));
}

function suggestionKey(suggestion: {
  fromUserId: string;
  toUserId: string;
  amount: string;
}): string {
  return `${suggestion.fromUserId}->${suggestion.toUserId}:${suggestion.amount}`;
}

beforeAll(async () => {
  app = await buildApp();
  [admin, member1, member2, member3] = await Promise.all([
    seedUser("expense-admin"),
    seedUser("expense-member-1"),
    seedUser("expense-member-2"),
    seedUser("expense-member-3"),
  ]);
});

afterAll(async () => {
  await cleanupSeededData();
  await app.close();
});

describe("group creation and membership", () => {
  it("creates a multi-member group and persists each member's role", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1, member2],
      uniqueName("Trip")
    );

    const response = await app.inject({
      method: "GET",
      url: `/groups/${group.id}`,
      headers: authHeaders(member1),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as GroupDetailResponse;

    expect(body.group.id).toBe(group.id);
    expect(body.yourRole).toBe("member");

    const memberIds = body.members.map((member) => member.userId).sort();
    expect(memberIds).toEqual([admin.id, member1.id, member2.id].sort());
    expect(body.members.find((member) => member.userId === admin.id)?.role).toBe("admin");

    const persisted = await prisma.groupMember.findMany({
      where: { groupId: group.id },
      orderBy: { userId: "asc" },
    });
    expect(persisted).toHaveLength(3);
    expect(persisted.filter((member) => member.role === "admin")).toHaveLength(1);
  });

  it("rejects an expense whose participants are not all group members", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1],
      uniqueName("Members only")
    );

    const response = await app.inject({
      method: "POST",
      url: `/groups/${group.id}/expenses`,
      headers: {
        ...authHeaders(admin),
        "x-idempotency-key": "expense-invalid-participants",
      },
      payload: {
        title: "Non-member dinner",
        amount: "10",
        assetCode: "XLM",
        splitType: "equal",
        shares: [{ userId: admin.id }, { userId: member2.id }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe("INVALID_SPLIT");
    expect(await prisma.expense.count({ where: { groupId: group.id } })).toBe(0);
  });
});

describe("expense creation and split rules", () => {
  it("stores an equal split whose shares sum exactly to the expense amount", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1, member2],
      uniqueName("Equal split")
    );

    const expense = await createExpenseViaApi(app, admin, group.id, {
      title: "Dinner",
      amount: "10",
      assetCode: "XLM",
      splitType: "equal",
      payerUserId: admin.id,
      shares: [{ userId: admin.id }, { userId: member1.id }, { userId: member2.id }],
    });

    expect(expense.amount).toBe("10");
    expect(expense.splitType).toBe("equal");
    expect(expense.shares).toHaveLength(3);

    const shares = new Map(expense.shares.map((share) => [share.userId, share]));
    // 10 / 3 leaves one stroop, which the first participant absorbs.
    expect(shares.get(admin.id)).toMatchObject({
      shareAmount: "3.3333334",
      status: "settled",
    });
    expect(shares.get(member1.id)).toMatchObject({
      shareAmount: "3.3333333",
      status: "pending",
    });
    expect(shares.get(member2.id)).toMatchObject({
      shareAmount: "3.3333333",
      status: "pending",
    });

    const shareTotal = expense.shares.reduce(
      (total, share) => total + stroops(share.shareAmount),
      0
    );
    expect(shareTotal).toBe(stroops("10"));

    const fetched = await app.inject({
      method: "GET",
      url: `/expenses/${expense.id}`,
      headers: authHeaders(member2),
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { expense: SerializedExpense }).expense.id).toBe(expense.id);
  });

  it("honours custom and percentage splits and rejects splits that do not balance", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1, member2],
      uniqueName("Custom split")
    );

    const custom = await createExpenseViaApi(app, admin, group.id, {
      title: "Shared groceries",
      amount: "20",
      assetCode: "XLM",
      splitType: "custom",
      payerUserId: admin.id,
      shares: [
        { userId: admin.id, amount: "5" },
        { userId: member1.id, amount: "10" },
        { userId: member2.id, amount: "5" },
      ],
    });

    const customShares = new Map(custom.shares.map((share) => [share.userId, share]));
    expect(customShares.get(admin.id)?.shareAmount).toBe("5");
    expect(customShares.get(member1.id)?.shareAmount).toBe("10");
    expect(customShares.get(member2.id)?.shareAmount).toBe("5");

    const percentage = await createExpenseViaApi(app, admin, group.id, {
      title: "Concert tickets",
      amount: "30",
      assetCode: "XLM",
      splitType: "percentage",
      payerUserId: admin.id,
      shares: [
        { userId: admin.id, percent: 20 },
        { userId: member1.id, percent: 30 },
        { userId: member2.id, percent: 50 },
      ],
    });

    const percentageShares = new Map(
      percentage.shares.map((share) => [share.userId, share])
    );
    expect(percentageShares.get(admin.id)?.shareAmount).toBe("6");
    expect(percentageShares.get(member1.id)?.shareAmount).toBe("9");
    expect(percentageShares.get(member2.id)?.shareAmount).toBe("15");

    const expenseCount = await prisma.expense.count({ where: { groupId: group.id } });

    const badCustom = await app.inject({
      method: "POST",
      url: `/groups/${group.id}/expenses`,
      headers: {
        ...authHeaders(admin),
        "x-idempotency-key": "expense-unbalanced-custom",
      },
      payload: {
        title: "Unbalanced custom split",
        amount: "20",
        assetCode: "XLM",
        splitType: "custom",
        shares: [
          { userId: admin.id, amount: "5" },
          { userId: member1.id, amount: "10" },
          { userId: member2.id, amount: "4" },
        ],
      },
    });
    expect(badCustom.statusCode).toBe(400);
    expect((badCustom.json() as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR"
    );

    const badPercentage = await app.inject({
      method: "POST",
      url: `/groups/${group.id}/expenses`,
      headers: {
        ...authHeaders(admin),
        "x-idempotency-key": "expense-unbalanced-percentage",
      },
      payload: {
        title: "Unbalanced percentage split",
        amount: "20",
        assetCode: "XLM",
        splitType: "percentage",
        shares: [
          { userId: admin.id, percent: 20 },
          { userId: member1.id, percent: 30 },
          { userId: member2.id, percent: 40 },
        ],
      },
    });
    expect(badPercentage.statusCode).toBe(400);
    expect((badPercentage.json() as { error: { code: string } }).error.code).toBe(
      "VALIDATION_ERROR"
    );

    expect(await prisma.expense.count({ where: { groupId: group.id } })).toBe(expenseCount);
  });
});

describe("net balances and debt simplification", () => {
  it("nets equal, custom, and percentage expenses into simplified transfers", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1, member2, member3],
      uniqueName("Net balances")
    );

    // A pays 40 equally: A +30, B/C/D -10.
    await createExpenseViaApi(app, admin, group.id, {
      title: "Rent",
      amount: "40",
      assetCode: "XLM",
      splitType: "equal",
      payerUserId: admin.id,
      shares: [
        { userId: admin.id },
        { userId: member1.id },
        { userId: member2.id },
        { userId: member3.id },
      ],
    });

    // B pays 20 with a custom split: B +15, A/C/D -5.
    await createExpenseViaApi(app, member1, group.id, {
      title: "Utilities",
      amount: "20",
      assetCode: "XLM",
      splitType: "custom",
      payerUserId: member1.id,
      shares: [
        { userId: admin.id, amount: "5" },
        { userId: member1.id, amount: "5" },
        { userId: member2.id, amount: "5" },
        { userId: member3.id, amount: "5" },
      ],
    });

    // C pays 10 by percentage: C +7, A -1, B -2, D -4.
    await createExpenseViaApi(app, member2, group.id, {
      title: "Snacks",
      amount: "10",
      assetCode: "XLM",
      splitType: "percentage",
      payerUserId: member2.id,
      shares: [
        { userId: admin.id, percent: 10 },
        { userId: member1.id, percent: 20 },
        { userId: member2.id, percent: 30 },
        { userId: member3.id, percent: 40 },
      ],
    });

    // A +24, B +3, C -8, D -19.
    const { balances, suggestions } = await loadGroupBalancesWithSuggestions(group.id);
    const nets = netMap(balances);
    expect(nets.get(admin.id)).toBe("24");
    expect(nets.get(member1.id)).toBe("3");
    expect(nets.get(member2.id)).toBe("-8");
    expect(nets.get(member3.id)).toBe("-19");

    expect(new Set(suggestions.map(suggestionKey))).toEqual(
      new Set([
        `${member3.id}->${admin.id}:19`,
        `${member2.id}->${admin.id}:5`,
        `${member2.id}->${member1.id}:3`,
      ])
    );

    // Applying the suggestions zeroes every balance.
    const remaining = new Map(
      balances.map((balance) => [balance.userId, Number(balance.net)])
    );
    for (const suggestion of suggestions) {
      remaining.set(
        suggestion.fromUserId,
        (remaining.get(suggestion.fromUserId) ?? 0) + Number(suggestion.amount)
      );
      remaining.set(
        suggestion.toUserId,
        (remaining.get(suggestion.toUserId) ?? 0) - Number(suggestion.amount)
      );
    }
    for (const net of remaining.values()) {
      expect(Math.abs(net)).toBeLessThan(1e-9);
    }

    const balancesResponse = await app.inject({
      method: "GET",
      url: `/groups/${group.id}/balances`,
      headers: authHeaders(member3),
    });
    expect(balancesResponse.statusCode).toBe(200);
    const balancesBody = balancesResponse.json() as BalanceResponse;
    const apiNets = netMap(balancesBody.balances);
    expect(apiNets.get(admin.id)).toBe("24");
    expect(apiNets.get(member1.id)).toBe("3");
    expect(apiNets.get(member2.id)).toBe("-8");
    expect(apiNets.get(member3.id)).toBe("-19");
    expect(balancesBody.suggestions).toHaveLength(3);
    expect(balancesBody.suggestions.every((item) => item.assetCode === "XLM")).toBe(true);

    const previewResponse = await app.inject({
      method: "GET",
      url: `/groups/${group.id}/settlement/preview`,
      headers: authHeaders(member3),
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json() as PreviewResponse;
    expect(preview.assetCode).toBe("XLM");
    expect(new Set(preview.operations.map(suggestionKey))).toEqual(
      new Set(suggestions.map(suggestionKey))
    );
  });
});

describe("settlement transaction generation", () => {
  it("builds an unsigned XDR to settle one member's expense share", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1],
      uniqueName("Expense settlement")
    );

    const expense = await createExpenseViaApi(app, admin, group.id, {
      title: "Taxi",
      amount: "25",
      assetCode: "XLM",
      splitType: "equal",
      payerUserId: admin.id,
      shares: [{ userId: admin.id }, { userId: member1.id }],
    });

    const response = await app.inject({
      method: "POST",
      url: `/expenses/${expense.id}/settle`,
      headers: authHeaders(member1),
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as SettlementCreationResponse;

    expect(body.settlement).toMatchObject({
      groupId: group.id,
      fromUserId: member1.id,
      toUserId: admin.id,
      amount: "12.5",
      assetCode: "XLM",
      assetIssuer: null,
      status: "pending",
      expenseId: expense.id,
    });
    expect(body.networkPassphrase).toBe(config.networkPassphrase);
    expect(body.expiresInSeconds).toBeGreaterThan(0);

    const parsed = TransactionBuilder.fromXDR(body.xdr, body.networkPassphrase);
    expect(parsed).toBeInstanceOf(Transaction);
    const tx = parsed as Transaction;

    expect(tx.source).toBe(member1.stellarPublicKey);
    expect(tx.operations).toHaveLength(1);

    const operation = tx.operations[0];
    expect(operation?.type).toBe("payment");
    if (operation?.type !== "payment") throw new Error("Expected a payment operation");

    expect(operation.destination).toBe(admin.stellarPublicKey);
    expect(operation.asset.isNative()).toBe(true);
    expect(Number(operation.amount)).toBe(12.5);
    expect(tx.memo.type).toBe("text");
    expect(body.settlement.memo).toBeTruthy();
    expect(tx.memo.value?.toString()).toBe(body.settlement.memo);

    const persisted = await prisma.settlement.findUnique({
      where: { id: body.settlement.id },
      include: { expenseShare: true },
    });
    expect(persisted).not.toBeNull();
    expect(persisted).toMatchObject({
      status: "pending",
      stellarTxHash: null,
      transactionXdr: null,
      expenseShareId: expect.any(String),
    });
    expect(persisted?.amount.toString()).toBe("12.5");
    expect(persisted?.expenseShare?.status).toBe("settling");
    expect(body.settlement.memo).toBe(`MP:${persisted?.shortCode}`);

    const history = await prisma.statusHistory.findMany({
      where: { entityType: "settlement", entityId: body.settlement.id },
    });
    expect(history.map((entry) => entry.status)).toContain("pending");
  });

  it("builds an unsigned XDR for a freeform settle-up against the net balance", async () => {
    const group = await createGroupWithMembers(
      app,
      admin,
      [member1, member2],
      uniqueName("Freeform settlement")
    );

    await createExpenseViaApi(app, admin, group.id, {
      title: "Group dinner",
      amount: "30",
      assetCode: "XLM",
      splitType: "equal",
      payerUserId: admin.id,
      shares: [{ userId: admin.id }, { userId: member1.id }, { userId: member2.id }],
    });

    const previewResponse = await app.inject({
      method: "GET",
      url: `/groups/${group.id}/settlement/preview`,
      headers: authHeaders(member1),
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json() as PreviewResponse;

    // Both debtors owe 10 to the payer; the greedy engine returns one
    // transfer per debtor.
    expect(preview.operations).toHaveLength(2);
    const settlementRequest = preview.operations.find(
      (operation) => operation.fromUserId === member1.id
    );
    expect(settlementRequest).toBeDefined();
    if (!settlementRequest) throw new Error("No suggestion for the debtor");

    const response = await app.inject({
      method: "POST",
      url: `/groups/${group.id}/settlements`,
      headers: authHeaders(member1),
      payload: {
        toUserId: settlementRequest.toUserId,
        amount: settlementRequest.amount,
        assetCode: preview.assetCode,
        assetIssuer: preview.assetIssuer,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as SettlementCreationResponse;
    expect(body.settlement).toMatchObject({
      groupId: group.id,
      fromUserId: member1.id,
      toUserId: admin.id,
      amount: "10",
      assetCode: "XLM",
      status: "pending",
      expenseId: null,
    });

    const parsed = TransactionBuilder.fromXDR(body.xdr, body.networkPassphrase);
    expect(parsed).toBeInstanceOf(Transaction);
    const tx = parsed as Transaction;
    expect(tx.source).toBe(member1.stellarPublicKey);
    expect(tx.operations).toHaveLength(1);

    const operation = tx.operations[0];
    if (operation?.type !== "payment") throw new Error("Expected a payment operation");
    expect(operation.destination).toBe(admin.stellarPublicKey);
    expect(operation.asset.isNative()).toBe(true);
    expect(Number(operation.amount)).toBe(10);
    expect(body.settlement.memo).toBeTruthy();
    expect(tx.memo.value?.toString()).toBe(body.settlement.memo);

    const persisted = await prisma.settlement.findUnique({
      where: { id: body.settlement.id },
    });
    expect(persisted).not.toBeNull();
    expect(persisted?.amount.toString()).toBe("10");
    expect(persisted?.expenseId).toBeNull();
    expect(persisted?.stellarTxHash).toBeNull();
    expect(body.settlement.memo).toBe(`MP:${persisted?.shortCode}`);
  });
});
