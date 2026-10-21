/**
 * Issue #847 — the group settlement and expense-splitting workflow, end to end
 * against a real Postgres.
 *
 * The unit suite proves the balance/simplification engine in isolation, and
 * `group-expense-database.test.ts` covers the two-party happy path plus the
 * archived-group guards. This file covers the part neither does: a three-member
 * group whose combined expenses produce a *non-trivial* settle-up plan, walked
 * through group creation → membership → expense recording → net balances →
 * simplified transfers → settlement creation → confirmation → the balance
 * sheet that results.
 *
 * Why Postgres rather than the mocked client the rest of the suite uses: every
 * assertion here is about rows the engine derived, not about a value a test
 * handed back. `DECIMAL(20,7)` storage, the share/payer join, the settlement's
 * effect on the balance sheet, and the rollback of a refused over-settlement
 * are all database behaviour. A mock would agree with the test by construction.
 *
 * The only substitution is `stellar.loadAccount` (a Horizon read): the suite
 * runs offline, and CONTRIBUTING keeps Horizon I/O behind src/services so this
 * is the documented seam. `app.inject` drives the real Fastify routes.
 *
 * Isolation: identities and group rows are unique to this file, and the global
 * setup empties every table once per run. `afterAll` removes this file's own
 * rows so a re-run against a shared database does not inherit them.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      // Funded far beyond any payment or reserve in this suite: preflight must
      // never be the thing a workflow assertion is really testing.
      loadAccount: vi.fn(async () => ({
        exists: true,
        sequence: "1",
        balances: [{ assetCode: "XLM", assetIssuer: null, balance: "10000.0000000" }],
        signers: [],
        thresholds: { low: 1, med: 1, high: 1 },
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { prisma } from "../../src/db";
import { signToken } from "../../src/plugins/auth";
import { fromStroops, toStroops } from "../../src/services/money";

interface Actor {
  id: string;
  publicKey: string;
  token: string;
}

let app: FastifyInstance;
let owner: Actor;
let member: Actor;
let debtor: Actor;
let groupId: string;
let firstExpenseId: string;
let secondExpenseId: string;
let requestNumber = 0;

/**
 * A distinct source address per request: rate-limit buckets key on it, so the
 * suite's own request volume must not decide whether a later call is served.
 */
function remoteAddress(): string {
  requestNumber += 1;
  return `10.68.${Math.floor(requestNumber / 250) % 250}.${(requestNumber % 250) + 1}`;
}

async function createActor(displayName: string): Promise<Actor> {
  const publicKey = Keypair.random().publicKey();
  const user = await prisma.user.create({
    data: { stellarPublicKey: publicKey, displayName },
    select: { id: true },
  });
  return { id: user.id, publicKey, token: signToken({ id: user.id, stellarPublicKey: publicKey }) };
}

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  actor: Actor | null,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method,
    url,
    remoteAddress: remoteAddress(),
    headers: actor ? { authorization: `Bearer ${actor.token}` } : {},
    payload,
  });
}

async function netBalances(actor: Actor): Promise<Record<string, string>> {
  const res = await call("GET", `/groups/${groupId}/balances`, actor);
  expect(res.statusCode).toBe(200);
  const balances = res.json().balances as { userId: string; net: string }[];
  return Object.fromEntries(balances.map((entry) => [entry.userId, entry.net]));
}

async function createExpense(actor: Actor, title: string, amount: string) {
  return call("POST", `/groups/${groupId}/expenses`, actor, {
    title,
    amount,
    assetCode: "XLM",
    splitType: "equal",
    shares: [{ userId: owner.id }, { userId: member.id }, { userId: debtor.id }],
  });
}

beforeAll(async () => {
  app = await buildApp();
  [owner, member, debtor] = await Promise.all([
    createActor("Workflow Owner"),
    createActor("Workflow Member"),
    createActor("Workflow Debtor"),
  ]);
});

afterAll(async () => {
  await app.close();
  if (groupId) {
    // Deleting the group cascades members, expenses, shares, and settlements;
    // the users are this file's own rows and go afterwards.
    await prisma.group.deleteMany({ where: { id: groupId } }).catch(() => undefined);
    await prisma.user
      .deleteMany({ where: { id: { in: [owner.id, member.id, debtor.id] } } })
      .catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe("group settlement workflow on a real Postgres (#847)", () => {
  it("creates the group and persists all three memberships", async () => {
    const created = await call("POST", "/groups", owner, {
      name: "Workflow Settlement Group",
    });
    expect(created.statusCode).toBe(200);
    groupId = created.json().group.id;

    // Membership is created through the public invite → join flow rather than
    // by inserting rows, so the flow this issue describes is exercised end to
    // end (a direct public-key invitation only creates a pending invitation).
    const invite = await call("POST", `/groups/${groupId}/invite`, owner, {
      maxUses: 5,
    });
    expect(invite.statusCode).toBe(200);
    const code = invite.json().invite.code as string;

    for (const actor of [member, debtor]) {
      const joined = await call("POST", "/groups/join", actor, { code });
      expect(joined.statusCode).toBe(200);
    }

    const members = await prisma.groupMember.findMany({
      where: { groupId },
      orderBy: { role: "asc" },
    });
    expect(members).toHaveLength(3);
    expect(members.map((m) => m.userId).sort()).toEqual(
      [owner.id, member.id, debtor.id].sort()
    );
    expect(members.filter((m) => m.role === "admin").map((m) => m.userId)).toEqual([owner.id]);
  });

  it("records two equal three-way expenses whose stored shares sum to each bill", async () => {
    const first = await createExpense(owner, "Owner covers dinner", "60.0000000");
    expect(first.statusCode).toBe(200);
    firstExpenseId = first.json().expense.id;

    const second = await createExpense(member, "Member covers taxis", "60.0000000");
    expect(second.statusCode).toBe(200);
    secondExpenseId = second.json().expense.id;

    const expenses = await prisma.expense.findMany({
      where: { groupId },
      orderBy: { createdAt: "asc" },
      include: { shares: true },
    });
    expect(expenses).toHaveLength(2);
    expect(expenses.map((e) => e.id)).toEqual([firstExpenseId, secondExpenseId]);
    expect(expenses.map((e) => [e.payerUserId, e.amount.toString()])).toEqual([
      [owner.id, "60"],
      [member.id, "60"],
    ]);

    for (const expense of expenses) {
      expect(expense.shares).toHaveLength(3);
      const total = expense.shares.reduce(
        (sum, share) => sum + toStroops(share.shareAmount.toString()),
        0n
      );
      // The parts must equal the whole after the split engine's rounding — the
      // invariant every balance below depends on.
      expect(fromStroops(total)).toBe(fromStroops(toStroops(expense.amount.toString())));
      expect(expense.shares.map((s) => s.shareAmount.toString())).toEqual([
        "20",
        "20",
        "20",
      ]);
    }
  });

  it("derives net balances from persisted shares: +20, +20, -40", async () => {
    const balances = await netBalances(owner);

    expect(balances[owner.id]).toBe("20");
    expect(balances[member.id]).toBe("20");
    expect(balances[debtor.id]).toBe("-40");

    // The net figure is not merely stored — it equals what the rows imply.
    const shares = await prisma.expenseShare.groupBy({
      by: ["userId"],
      where: { expense: { groupId } },
      _sum: { shareAmount: true },
    });
    const paid = await prisma.expense.groupBy({
      by: ["payerUserId"],
      where: { groupId },
      _sum: { amount: true },
    });
    for (const actor of [owner, member, debtor]) {
      const owed = shares.find((s) => s.userId === actor.id)?._sum.shareAmount ?? 0;
      const advanced = paid.find((p) => p.payerUserId === actor.id)?._sum.amount ?? 0;
      expect(toStroops(balances[actor.id]!)).toBe(toStroops(advanced.toString()) - toStroops(owed.toString()));
    }
  });

  it("simplifies the debts into (n-1) transfers: the debtor pays each creditor once", async () => {
    const preview = await call("GET", `/groups/${groupId}/settlement/preview`, owner);
    expect(preview.statusCode).toBe(200);

    const operations = preview.json().operations as {
      fromUserId: string;
      toUserId: string;
      amount: string;
    }[];
    expect(operations).toHaveLength(2);
    for (const op of operations) {
      expect(op.fromUserId).toBe(debtor.id);
      expect(op.amount).toBe("20");
    }
    expect(new Set(operations.map((op) => op.toUserId))).toEqual(
      new Set([owner.id, member.id])
    );

    // A three-member settle-up needs at most n-1 transfers, and nothing is
    // left over: the debtor's outflows equal the debt exactly.
    const outflow = operations.reduce((sum, op) => sum + toStroops(op.amount), 0n);
    expect(outflow).toBe(toStroops("40"));
  });

  it("creates a settlement intent, persisting the row, its XDR, history, and audit entry", async () => {
    const res = await call("POST", `/groups/${groupId}/settlements`, debtor, {
      toUserId: owner.id,
      amount: "20",
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.xdr).toBe("string");
    expect(body.xdr.length).toBeGreaterThan(0);
    expect(body.settlement).toMatchObject({ status: "pending" });

    const settlement = await prisma.settlement.findUniqueOrThrow({
      where: { id: body.settlement.id },
    });
    expect(settlement).toMatchObject({
      groupId,
      fromUserId: debtor.id,
      toUserId: owner.id,
      status: "pending",
      assetCode: "XLM",
    });
    expect(settlement.amount.toString()).toBe("20");

    const history = await prisma.statusHistory.findMany({
      where: { entityType: "settlement", entityId: settlement.id },
    });
    expect(history).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending", source: "api" })])
    );
    expect(
      await prisma.auditLog.count({
        where: { groupId, entityId: settlement.id, action: "settlement.create" },
      })
    ).toBe(1);
  });

  it("keeps the balance sheet unchanged while the settlement is only pending", async () => {
    // /balances nets confirmed settlements only; a created intent is not a
    // payment, and the debt must not disappear before money moves.
    const balances = await netBalances(owner);
    expect(balances[owner.id]).toBe("20");
    expect(balances[member.id]).toBe("20");
    expect(balances[debtor.id]).toBe("-40");
  });

  it("refuses an over-settlement and rolls back every row it would have written", async () => {
    const before = {
      settlements: await prisma.settlement.count({ where: { groupId } }),
      history: await prisma.statusHistory.count(),
      audit: await prisma.auditLog.count({ where: { groupId, action: "settlement.create" } }),
    };

    // The debtor still owes 20 after the pending intent; 30 exceeds it.
    const res = await call("POST", `/groups/${groupId}/settlements`, debtor, {
      toUserId: member.id,
      amount: "30",
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OVER_SETTLEMENT");

    expect(await prisma.settlement.count({ where: { groupId } })).toBe(before.settlements);
    expect(await prisma.statusHistory.count()).toBe(before.history);
    expect(
      await prisma.auditLog.count({ where: { groupId, action: "settlement.create" } })
    ).toBe(before.audit);
  });

  it("applies a confirmed settlement to the stored balance sheet", async () => {
    const settlement = await prisma.settlement.findFirstOrThrow({
      where: { groupId, fromUserId: debtor.id, toUserId: owner.id },
    });

    // Wallet signature + Horizon acceptance are what move a row to confirmed;
    // that is the worker's job, so this writes exactly what confirmation writes
    // and then reads the derived balances back.
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: { status: "confirmed", confirmedAt: new Date() },
    });

    const balances = await netBalances(debtor);
    expect(balances[owner.id]).toBe("0");
    expect(balances[member.id]).toBe("20");
    expect(balances[debtor.id]).toBe("-20");

    // One debt remains, so the settle-up plan shrinks to a single transfer.
    const preview = await call("GET", `/groups/${groupId}/settlement/preview`, member);
    expect(preview.statusCode).toBe(200);
    const operations = preview.json().operations as {
      fromUserId: string;
      toUserId: string;
      amount: string;
    }[];
    expect(operations).toEqual([
      expect.objectContaining({
        fromUserId: debtor.id,
        toUserId: member.id,
        amount: "20",
      }),
    ]);
  });

  it("recomputes balances from the database after a new expense is added", async () => {
    // A third bill, from the owner, proves the sheet is derived on read rather
    // than cached from the settle-up above.
    const added = await createExpense(owner, "Owner covers dessert", "30.0000000");
    expect(added.statusCode).toBe(200);

    const balances = await netBalances(owner);
    // owner +20, member +10, debtor -30 — a fresh netting of all three bills
    // and the confirmed settlement, not the previous figures adjusted.
    expect(balances[owner.id]).toBe("20");
    expect(balances[member.id]).toBe("10");
    expect(balances[debtor.id]).toBe("-30");

    expect(
      await prisma.expense.count({ where: { groupId } })
    ).toBe(3);
  });
});
