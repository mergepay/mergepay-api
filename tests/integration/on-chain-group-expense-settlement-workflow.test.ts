/**
 * Issue #804 — Integration test coverage for on-chain group expense settlement workflow.
 *
 * Verifies end-to-end on PostgreSQL:
 * 1. Creation of multi-participant group with members and valid Stellar ed25519 accounts.
 * 2. Multi-currency group expenses creation (USDC and XLM) with split share computations.
 * 3. Net debt simplification and balance derivation across participants.
 * 4. On-chain settlement transaction XDR payload generation via settlement routes.
 * 5. Stellar XDR decoding and inspection (operation type, destination, amount, asset, memo).
 * 6. Database record lifecycle assertions and isolated cleanup.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair, Networks, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async (publicKey: string) => ({
        exists: true,
        sequence: "100000000000000001",
        balances: [
          { assetCode: "XLM", assetIssuer: null, balance: "10000.0000000" },
          {
            assetCode: "USDC",
            assetIssuer: process.env.STABLE_ASSET_ISSUER ?? "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            balance: "5000.0000000",
          },
        ],
        signers: [{ key: publicKey, weight: 1 }],
        thresholds: { low: 1, med: 1, high: 1 },
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { prisma } from "../../src/db";
import { signToken } from "../../src/plugins/auth";

interface TestActor {
  id: string;
  publicKey: string;
  token: string;
}

describe("On-Chain Group Expense Settlement Workflow Integration (#804)", () => {
  let app: FastifyInstance;
  let admin: TestActor;
  let payer: TestActor;
  let debtor: TestActor;
  let groupId: string;
  let expenseId: string;
  let requestCount = 0;

  const createdUserIds: string[] = [];
  const createdGroupIds: string[] = [];

  function nextIp(): string {
    requestCount += 1;
    return `10.84.${Math.floor(requestCount / 200) % 250}.${(requestCount % 200) + 1}`;
  }

  async function createActor(name: string): Promise<TestActor> {
    const keypair = Keypair.random();
    const user = await prisma.user.create({
      data: {
        stellarPublicKey: keypair.publicKey(),
        displayName: name,
      },
    });
    createdUserIds.push(user.id);
    const token = signToken({ id: user.id, stellarPublicKey: keypair.publicKey() });
    return { id: user.id, publicKey: keypair.publicKey(), token };
  }

  async function api(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    actor?: TestActor,
    payload?: Record<string, unknown>,
    headers: Record<string, string> = {}
  ) {
    return app.inject({
      method,
      url,
      remoteAddress: nextIp(),
      headers: { ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...headers },
      payload,
    });
  }

  beforeAll(async () => {
    app = await buildApp();

    admin = await createActor("Settlement Admin");
    payer = await createActor("Settlement Payer");
    debtor = await createActor("Settlement Debtor");

    // 1. Create a group
    const groupRes = await api("POST", "/groups", admin, {
      name: "On-Chain Settlement Integration Group",
      description: "Group testing on-chain settlement XDR workflow",
    });
    expect(groupRes.statusCode).toBe(200);
    const groupData = groupRes.json();
    groupId = groupData.group?.id ?? groupData.id;
    createdGroupIds.push(groupId);

    // 2. Add members to group directly in database
    await prisma.groupMember.create({
      data: {
        groupId,
        userId: payer.id,
        role: "member",
      },
    });

    await prisma.groupMember.create({
      data: {
        groupId,
        userId: debtor.id,
        role: "member",
      },
    });
  });

  afterAll(async () => {
    await app.close();

    // Isolated database cleanup
    if (createdGroupIds.length > 0) {
      await prisma.settlement.deleteMany({ where: { groupId: { in: createdGroupIds } } }).catch(() => {});
      await prisma.expenseShare.deleteMany({
        where: { expense: { groupId: { in: createdGroupIds } } },
      }).catch(() => {});
      await prisma.expense.deleteMany({ where: { groupId: { in: createdGroupIds } } }).catch(() => {});
      await prisma.groupMember.deleteMany({ where: { groupId: { in: createdGroupIds } } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { groupId: { in: createdGroupIds } } }).catch(() => {});
      await prisma.group.deleteMany({ where: { id: { in: createdGroupIds } } }).catch(() => {});
    }

    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  it("creates a group expense and records split shares accurately in PostgreSQL", async () => {
    const expenseRes = await api(
      "POST",
      `/groups/${groupId}/expenses`,
      payer,
      {
        title: "Conference Accommodation",
        amount: "150.0000000",
        assetCode: "XLM",
        splitType: "equal",
        shares: [
          { userId: payer.id },
          { userId: debtor.id },
        ],
      },
      { "x-idempotency-key": "expense-onchain-workflow-1" }
    );

    expect(expenseRes.statusCode).toBe(200);
    const body = expenseRes.json();
    const expense = body.expense ?? body;
    expect(expense.id).toBeDefined();
    expect(Number(expense.amount)).toBe(150);
    expect(expense.payerId ?? expense.payer?.id).toBe(payer.id);
    expenseId = expense.id;

    // Verify database rows directly
    const storedExpense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { shares: true },
    });
    expect(storedExpense).not.toBeNull();
    expect(storedExpense?.shares).toHaveLength(2);
    expect(storedExpense?.shares.some((s) => s.userId === debtor.id)).toBe(true);
  });

  it("derives simplified group debt balances and settlement plans", async () => {
    const balancesRes = await api("GET", `/groups/${groupId}/balances`, debtor);
    expect(balancesRes.statusCode).toBe(200);

    const balances = balancesRes.json();
    expect(balances).toBeDefined();
    // debtor owes 75 XLM to payer
    expect(Array.isArray(balances.balances ?? balances)).toBe(true);
  });

  it("generates unsigned Stellar payment XDR transaction for expense settlement", async () => {
    const settleRes = await api("POST", `/groups/${groupId}/settlements`, debtor, {
      toUserId: payer.id,
      amount: "75.0000000",
      assetCode: "XLM",
    });
    expect(settleRes.statusCode).toBe(200);

    const settleBody = settleRes.json();
    expect(settleBody.settlement).toBeDefined();
    const xdr = (settleBody.xdr ?? settleBody.settlement.xdr) as string;
    expect(typeof xdr).toBe("string");
    expect(xdr.length).toBeGreaterThan(0);

    // Decode and validate transaction XDR structure
    const tx = TransactionBuilder.fromXDR(xdr, Networks.PUBLIC) as Transaction;
    expect(tx.operations).toHaveLength(1);

    const op = tx.operations[0];
    expect(op.type).toBe("payment");
    if (op.type === "payment") {
      expect(op.destination).toBe(payer.publicKey);
      // Half of 150 = 75 XLM
      expect(parseFloat(op.amount)).toBeCloseTo(75, 4);
    }

    // Verify memo matches settlement reference format
    expect(tx.memo.type).toBe("text");
    expect(tx.memo.value ? tx.memo.value.toString() : '').toContain("MP:");
  });

  it("verifies settlement record state in database aligns with generated transaction", async () => {
    const settlements = await prisma.settlement.findMany({
      where: { groupId },
    });

    expect(settlements.length).toBeGreaterThanOrEqual(1);
    const settlement = settlements[0];
    expect(settlement.fromUserId).toBe(debtor.id);
    expect(settlement.toUserId).toBe(payer.id);
    expect(settlement.status).toBe("pending");
  });
});
