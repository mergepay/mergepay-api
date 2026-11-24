/**
 * Issue #1021 — the product's primary path against a real Postgres.
 *
 * Unit suites mock `src/db`; this one drives the real Fastify app and real
 * Prisma client through create group → invite/join → split expense → settlement
 * intent, asserting the persisted rows and the audit records written in the
 * same transactions. The only seam stubbed is Horizon's account lookup, which
 * keeps the suite offline without touching the database path.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
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
import { AuditAction } from "../../src/services/audit-actions";
import { fromStroops, toStroops } from "../../src/services/money";

interface Actor {
  id: string;
  publicKey: string;
  token: string;
}

let app: FastifyInstance;
let owner: Actor;
let member: Actor;
let outsider: Actor;
let groupId: string;
let expenseId: string;
let requestNumber = 0;

async function createActor(displayName: string): Promise<Actor> {
  const publicKey = Keypair.random().publicKey();
  const user = await prisma.user.create({
    data: { stellarPublicKey: publicKey, displayName: `${displayName}-${Date.now()}-${requestNumber++}` },
    select: { id: true },
  });
  return { id: user.id, publicKey, token: signToken({ id: user.id, stellarPublicKey: publicKey }) };
}

async function call(
  method: "GET" | "POST",
  url: string,
  actor: Actor | null,
  payload?: Record<string, unknown>,
  headers: Record<string, string> = {}
) {
  return app.inject({
    method,
    url,
    remoteAddress: `10.102.${Math.floor(requestNumber / 250) % 250}.${(requestNumber++ % 250) + 1}`,
    headers: { ...(actor ? { authorization: `Bearer ${actor.token}` } : {}), ...headers },
    payload,
  });
}

async function findAudit(where: Prisma.AuditLogWhereInput) {
  return prisma.auditLog.findFirst({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

beforeAll(async () => {
  app = await buildApp({ rateLimit: "off" });
  [owner, member, outsider] = await Promise.all([
    createActor("flow-owner"),
    createActor("flow-member"),
    createActor("flow-outsider"),
  ]);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("full group → expense → settlement intent flow on real Postgres (#1021)", () => {
  it("creates a group, joins a member, and audits both steps atomically", async () => {
    const created = await call("POST", "/groups", owner, {
      name: `Issue 1021 Flow ${Date.now()}`,
    });
    expect(created.statusCode).toBe(200);
    groupId = created.json().group.id as string;

    const invite = await call("POST", `/groups/${groupId}/invite`, owner, { maxUses: 5 });
    expect(invite.statusCode).toBe(200);
    const code = invite.json().invite.code as string;

    const joined = await call("POST", "/groups/join", member, { code });
    expect(joined.statusCode).toBe(200);

    const members = await prisma.groupMember.findMany({ where: { groupId } });
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.userId === owner.id)?.role).toBe("admin");
    expect(members.find((m) => m.userId === member.id)?.role).toBe("member");

    expect(
      await findAudit({
        groupId,
        action: AuditAction.GROUP_CREATE,
        userId: owner.id,
        entityType: "group",
        entityId: groupId,
      })
    ).not.toBeNull();
    expect(
      await findAudit({
        groupId,
        action: AuditAction.GROUP_JOIN,
        userId: member.id,
        entityType: "group",
        entityId: groupId,
      })
    ).not.toBeNull();

  });

  it("persists a multi-way split expense whose shares sum exactly to the total", async () => {
    const denied = await call("POST", `/groups/${groupId}/expenses`, outsider, {
      title: "Outsider expense",
      amount: "30",
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: outsider.id }],
    }, { "x-idempotency-key": "expense-int-47937" });
    expect(denied.statusCode).toBe(403);

    const created = await call("POST", `/groups/${groupId}/expenses`, owner, {
      title: "Shared dinner",
      amount: "30.0000000",
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: owner.id }, { userId: member.id }],
    }, { "x-idempotency-key": "expense-int-78818" });
    expect(created.statusCode).toBe(200);
    expenseId = created.json().expense.id as string;

    const expense = await prisma.expense.findUniqueOrThrow({
      where: { id: expenseId },
      include: { shares: true },
    });
    expect(expense.groupId).toBe(groupId);
    expect(expense.payerUserId).toBe(owner.id);
    expect(expense.assetCode).toBe("XLM");
    expect(expense.amount.toString()).toBe("30");
    expect(expense.shares).toHaveLength(2);

    const shareTotal = expense.shares.reduce(
      (sum, share) => sum + toStroops(share.shareAmount.toString()),
      0n
    );
    expect(fromStroops(shareTotal)).toBe("30");
    expect(expense.shares.map((s) => s.status).sort()).toEqual(["pending", "settled"]);

    expect(
      await findAudit({
        groupId,
        action: AuditAction.EXPENSE_CREATE,
        entityType: "expense",
        entityId: expenseId,
      })
    ).not.toBeNull();

  });

  it("creates a settlement intent tied to the expense with history and audit rows", async () => {
    const created = await call("POST", `/expenses/${expenseId}/settle`, member, {});
    expect(created.statusCode).toBe(200);
    const body = created.json();
    expect(typeof body.xdr).toBe("string");
    expect(body.xdr.length).toBeGreaterThan(0);

    const settlementId = body.settlement.id as string;
    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settlement).toMatchObject({
      groupId,
      expenseId,
      fromUserId: member.id,
      toUserId: owner.id,
      status: "pending",
      assetCode: "XLM",
    });
    expect(settlement.amount.toString()).toBe("15");

    const history = await prisma.statusHistory.findMany({
      where: { entityType: "settlement", entityId: settlementId },
    });
    expect(history).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "pending", source: "api" })])
    );
    expect(
      await findAudit({
        groupId,
        action: "settlement.create",
        entityType: "settlement",
        entityId: settlementId,
      })
    ).not.toBeNull();
  });

  it("refuses a non-member settlement and leaves no partial writes", async () => {
    const before = {
      settlements: await prisma.settlement.count({ where: { groupId } }),
      audits: await prisma.auditLog.count({ where: { groupId, action: "settlement.create" } }),
    };

    const denied = await call("POST", `/expenses/${expenseId}/settle`, outsider, {});
    expect(denied.statusCode).toBe(403);

    expect(await prisma.settlement.count({ where: { groupId } })).toBe(before.settlements);
    expect(
      await prisma.auditLog.count({ where: { groupId, action: "settlement.create" } })
    ).toBe(before.audits);
  });
});
