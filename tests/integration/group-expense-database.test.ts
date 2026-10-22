/**
 * Issue #646 — the group and expense workflow run against a real Postgres.
 *
 * Every other suite in this repository replaces `src/db` with a `vi.mock`
 * object. That is the right trade for unit speed, but it cannot answer the
 * questions this file asks, because a mock returns whatever the test told it to
 * return:
 *
 *   - do an expense's split shares, stored as `DECIMAL(20,7)`, actually sum to
 *     the expense amount after the rounding the engine applies?
 *   - when a settlement is refused, does its transaction leave no row behind —
 *     not in `settlements`, not in `status_history`, not in `audit_logs`?
 *   - does the audit record commit or roll back *with* the change it documents?
 *   - do the foreign keys and unique constraints the code relies on exist in
 *     the schema the harness just deployed?
 *
 * So this file uses the real Prisma client, the real Fastify instance, and the
 * real HTTP path (`app.inject`). The only substitution is
 * `src/services/stellar.loadAccount`, which reads a payer's account from
 * Horizon: CONTRIBUTING requires this suite to run offline, and the mock is the
 * repo's own convention for that (see tests/settlement-creation-idempotency.test.ts).
 * Nothing on the database path is stubbed.
 *
 * Data is per-run rather than per-suite: identities are fresh keypairs and the
 * global setup empties every table first, so the counts asserted here describe
 * this run only.
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
      // Funded well past any payment, envelope fee, and reserve in this suite,
      // so preflight is never what a test is actually checking.
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

const EXPENSE_AMOUNT = "30.1000000";

let app: FastifyInstance;
let owner: Actor;
let member: Actor;
let outsider: Actor;
let groupId: string;
let inviteCode: string;
let expenseId: string;
let requestNumber = 0;

/**
 * A distinct source address per request. Rate-limit buckets key on it, so
 * reusing one address would let the suite's own volume decide whether a later
 * request is served or throttled.
 */
function remoteAddress(): string {
  requestNumber += 1;
  return `10.66.${Math.floor(requestNumber / 250) % 250}.${(requestNumber % 250) + 1}`;
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

async function auditActions(groupId: string, entityType?: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    where: { groupId, ...(entityType ? { entityType } : {}) },
    orderBy: { createdAt: "asc" },
    select: { action: true },
  });
  return rows.map((row) => row.action);
}

beforeAll(async () => {
  app = await buildApp();
  [owner, member, outsider] = await Promise.all([
    createActor("Integration Owner"),
    createActor("Integration Member"),
    createActor("Integration Outsider"),
  ]);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("integration suite on a real Postgres (#646)", () => {
  it("creates a group and persists its creator as the only admin", async () => {
    const res = await call("POST", "/groups", owner, {
      name: "Integration Dinner",
      description: "Created by the #646 suite",
    });
    expect(res.statusCode).toBe(200);
    groupId = res.json().group.id;

    const group = await prisma.group.findUnique({
      where: { id: groupId },
      include: { members: true },
    });
    expect(group?.createdByUserId).toBe(owner.id);
    expect(group?.members).toHaveLength(1);
    expect(group?.members[0]).toMatchObject({ userId: owner.id, role: "admin" });

    // The write and its audit row share one transaction (auditTx). Reading both
    // back is what proves that pairing survived the round trip to Postgres.
    expect(await auditActions(groupId)).toContain("group.create");
  });

  it("lets a second user join with the invite code, and re-joining is a no-op", async () => {
    const inviteRes = await call("POST", `/groups/${groupId}/invite`, owner, { maxUses: 5 });
    expect(inviteRes.statusCode).toBe(200);
    inviteCode = inviteRes.json().invite.code;

    const joinRes = await call("POST", "/groups/join", member, { code: inviteCode });
    expect(joinRes.statusCode).toBe(200);

    const first = await prisma.invite.findUniqueOrThrow({ where: { code: inviteCode } });
    expect(first.uses).toBe(1);

    // The route documents a repeat join as a no-op. Only the database can show
    // that "no-op" means no second membership row and no second increment.
    const again = await call("POST", "/groups/join", member, { code: inviteCode });
    expect(again.statusCode).toBe(200);
    const after = await prisma.invite.findUniqueOrThrow({ where: { code: inviteCode } });
    expect(after.uses).toBe(1);

    const members = await prisma.groupMember.findMany({
      where: { groupId },
      orderBy: { role: "asc" },
    });
    expect(members.map((m) => m.role)).toEqual(["admin", "member"]);
    expect(members.map((m) => m.userId).sort()).toEqual([owner.id, member.id].sort());

    // #649 attributed these rows. Read them by group rather than by actor, so
    // the assertion fails again if the column is ever dropped — an actor-scoped
    // lookup passes whether or not the group id was stored.
    expect(await auditActions(groupId)).toContain("group.join");
    expect(await auditActions(groupId)).toContain("group.invite_code_create");
    expect(await prisma.auditLog.count({ where: { action: "group.join", userId: member.id } })).toBe(1);
  });

  it("refuses a non-member before any expense row exists", async () => {
    const res = await call("POST", `/groups/${groupId}/expenses`, outsider, {
      title: "Not yours to add",
      amount: EXPENSE_AMOUNT,
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: outsider.id }],
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.expense.count({ where: { groupId } })).toBe(0);
  });

  it("records an equal split whose stored shares sum exactly to the expense amount", async () => {
    const res = await call("POST", `/groups/${groupId}/expenses`, owner, {
      title: "Dinner",
      amount: EXPENSE_AMOUNT,
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: owner.id }, { userId: member.id }],
    });
    expect(res.statusCode).toBe(200);
    expenseId = res.json().expense.id;

    const shares = await prisma.expenseShare.findMany({
      where: { expenseId },
      orderBy: { id: "asc" },
    });
    expect(shares).toHaveLength(2);

    // 30.1000000 does not divide evenly by two in stroops, so this is the split
    // engine's rounding decision as Postgres stored it. The invariant the
    // settlement math depends on is that the parts still equal the whole.
    const total = shares.reduce((sum, s) => sum + toStroops(s.shareAmount.toString()), 0n);
    expect(fromStroops(total)).toBe(fromStroops(toStroops(EXPENSE_AMOUNT)));

    const payerShare = shares.find((s) => s.userId === owner.id);
    const owedShare = shares.find((s) => s.userId === member.id);
    expect(payerShare?.status).toBe("settled");
    expect(owedShare?.status).toBe("pending");

    const expense = await prisma.expense.findUniqueOrThrow({ where: { id: expenseId } });
    expect(expense).toMatchObject({ groupId, payerUserId: owner.id, assetCode: "XLM", splitType: "equal" });
    expect(expense.assetIssuer).toBeNull();
    expect(await auditActions(groupId, "expense")).toContain("expense.create");
  });

  it("refuses a split that includes a non-member, and writes nothing", async () => {
    const res = await call("POST", `/groups/${groupId}/expenses`, owner, {
      title: "Bad split",
      amount: EXPENSE_AMOUNT,
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: owner.id }, { userId: outsider.id }],
    });
    expect(res.statusCode).toBe(400);
    // `Errors.badRequest` upper-cases every code (src/lib/errors.ts:227), so a
    // route that throws `invalid_split` answers `INVALID_SPLIT`.
    expect(res.json().error.code).toBe("INVALID_SPLIT");
    expect(await prisma.expense.count({ where: { groupId, title: "Bad split" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { groupId, action: "expense.create" } })).toBe(1);
  });

  it("derives balances from the stored shares, not from the request that made them", async () => {
    const shares = await prisma.expenseShare.findMany({ where: { expenseId } });
    const owed = shares.find((s) => s.status === "pending")!;

    const res = await call("GET", `/groups/${groupId}/balances`, owner);
    expect(res.statusCode).toBe(200);
    const balances = res.json().balances as { userId: string; net: string }[];

    expect(balances.find((b) => b.userId === owed.userId)?.net).toBe(
      // the debtor's net is exactly the outstanding share, negative
      `-${owed.shareAmount.toString()}`
    );
    expect(balances.find((b) => b.userId === owner.id)?.net).toBe(owed.shareAmount.toString());

    const preview = await call("GET", `/groups/${groupId}/settlement/preview`, owner);
    expect(preview.statusCode).toBe(200);
    const operations = preview.json().operations as { amount: string }[];
    expect(operations).toHaveLength(1);
    expect(toStroops(operations[0]!.amount)).toBe(toStroops(owed.shareAmount.toString()));
  });

  it("rejects an over-settlement and rolls the whole transaction back", async () => {
    const before = {
      settlements: await prisma.settlement.count({ where: { groupId } }),
      statusHistory: await prisma.statusHistory.count(),
      audit: await prisma.auditLog.count({ where: { groupId, action: "settlement.create" } }),
    };

    const res = await call("POST", `/groups/${groupId}/settlements`, member, {
      toUserId: owner.id,
      amount: "9000.0000000",
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("OVER_SETTLEMENT");

    // The settlement, its status row, and its audit record are created inside
    // one transaction. A mocked client can be told to have rolled back; only
    // Postgres can show that nothing was left behind.
    expect(await prisma.settlement.count({ where: { groupId } })).toBe(before.settlements);
    expect(await prisma.statusHistory.count()).toBe(before.statusHistory);
    expect(await prisma.auditLog.count({ where: { groupId, action: "settlement.create" } })).toBe(
      before.audit
    );
  });

  it("settles the outstanding debt and persists the intent, status history, and audit row", async () => {
    const [pendingShare] = await prisma.expenseShare.findMany({
      where: { expenseId, status: "pending" },
    });
    const debt = pendingShare!.shareAmount.toString();

    const res = await call("POST", `/groups/${groupId}/settlements`, member, {
      toUserId: owner.id,
      amount: debt,
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const settlementId = body.settlement.id as string;

    const settlement = await prisma.settlement.findUniqueOrThrow({ where: { id: settlementId } });
    expect(settlement).toMatchObject({ groupId, fromUserId: member.id, toUserId: owner.id, status: "pending" });
    expect(settlement.amount.toString()).toBe(debt);
    expect(settlement.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(typeof body.xdr).toBe("string");
    expect(body.xdr.length).toBeGreaterThan(0);

    const history = await prisma.statusHistory.findMany({
      where: { entityType: "settlement", entityId: settlementId },
    });
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "pending", source: "api" }),
      ])
    );

    expect(await auditActions(groupId, "settlement")).toContain("settlement.create");

    // The debt is gone, so the same request again must be refused: the limit is
    // computed from persisted rows, which is exactly what this suite exists to
    // check.
    const repeat = await call("POST", `/groups/${groupId}/settlements`, member, {
      toUserId: owner.id,
      amount: debt,
      assetCode: "XLM",
    });
    expect(repeat.statusCode).toBe(400);
    expect(repeat.json().error.code).toBe("OVER_SETTLEMENT");

    // A created intent is not yet a payment. `verifySettlementLimit` counts
    // every non-failed row (src/services/group-balances.ts:188), so the repeat
    // above is refused, while `/balances` only nets rows with status `confirmed`
    // (same file, line 78) — so the debt is still visible here. Both halves of
    // that asymmetry are decisions only persisted rows can show.
    const pending = await call("GET", `/groups/${groupId}/balances`, owner);
    const netWhilePending = (pending.json().balances as { userId: string; net: string }[]).find(
      (b) => b.userId === member.id
    )!.net;
    expect(toStroops(netWhilePending)).toBe(-toStroops(debt));

    // The wallet's signature and Horizon acceptance are what move a row to
    // `confirmed`; that transition is the worker's job, so this writes it the
    // way confirmation would and reads the balance back. Deriving zero from the
    // stored rows — rather than from the request that created them — is the
    // point of the whole suite.
    await prisma.settlement.update({
      where: { id: settlementId },
      data: { status: "confirmed", confirmedAt: new Date() },
    });

    const confirmed = await call("GET", `/groups/${groupId}/balances`, owner);
    const netAfterConfirm = (confirmed.json().balances as { userId: string; net: string }[]).find(
      (b) => b.userId === member.id
    )!.net;
    expect(toStroops(netAfterConfirm)).toBe(0n);

    // With the debt paid there is nothing left to settle, so a third attempt is
    // refused too — now against a confirmed row.
    const afterConfirmed = await call("POST", `/groups/${groupId}/settlements`, member, {
      toUserId: owner.id,
      amount: debt,
      assetCode: "XLM",
    });
    expect(afterConfirmed.statusCode).toBe(400);
    expect(afterConfirmed.json().error.code).toBe("OVER_SETTLEMENT");
  });

  it("enforces the constraints the route handlers assume the schema provides", async () => {
    // Nothing in the application code checks these — each relies on the
    // database rejecting the write. They only hold if the deployed schema has
    // the constraints, which is what the global setup provisions here.
    await expect(
      prisma.expense.create({
        data: {
          groupId: "group_that_does_not_exist",
          payerUserId: owner.id,
          title: "Orphan",
          amount: "1.0000000",
          assetCode: "XLM",
          splitType: "equal",
        },
      })
    ).rejects.toMatchObject({ code: "P2003" });

    await expect(
      prisma.user.create({
        data: { stellarPublicKey: owner.publicKey, displayName: "Impostor" },
      })
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      prisma.groupMember.create({ data: { groupId, userId: owner.id, role: "member" } })
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("serves a group's expense list from the database the caller was authorized against", async () => {
    const memberRes = await call("GET", `/groups/${groupId}/expenses`, member);
    expect(memberRes.statusCode).toBe(200);
    expect(memberRes.json().expenses).toHaveLength(1);

    const outsiderRes = await call("GET", `/groups/${groupId}/expenses`, outsider);
    expect(outsiderRes.statusCode).toBe(403);
  });
});

/**
 * Issue #649 — a group's audit feed has to show every change made to it.
 *
 * `listAuditLogs` filters on the `groupId` *column*, so an event that stores
 * its group only inside `metadata` is written and then never returned. A mocked
 * `src/db` cannot see that: it records whatever payload it is handed, so the
 * route tests pass while the feature is broken. These assertions go out through
 * the HTTP endpoint, which is what an administrator actually reads.
 */
describe("group audit feed on a real Postgres (#649)", () => {
  let feedGroupId: string;
  let joiner: Actor;

  it("attributes membership and webhook events to the group they changed", async () => {
    const group = await call("POST", "/groups", owner, { name: "Audit Feed" });
    expect(group.statusCode).toBe(200);
    feedGroupId = group.json().group.id;

    const code = await call("POST", `/groups/${feedGroupId}/invite`, owner, {});
    expect(code.statusCode).toBe(200);

    joiner = await createActor("Audit Joiner");
    const direct = await call("POST", `/groups/${feedGroupId}/invite`, owner, {
      publicKey: joiner.publicKey,
    });
    expect(direct.statusCode).toBe(201);

    const joined = await call("POST", "/groups/join", joiner, {
      code: code.json().invite.code,
    });
    expect(joined.statusCode).toBe(200);

    const registered = await call("POST", `/groups/${feedGroupId}/webhooks`, owner, {
      url: "https://example.com/mergepay-hook",
      events: ["expense.created"],
    });
    expect(registered.statusCode).toBe(200);
    const hookId = registered.json().webhook.id;

    const deregistered = await call(
      "DELETE",
      `/groups/${feedGroupId}/webhooks/${hookId}`,
      owner
    );
    expect(deregistered.statusCode).toBe(200);

    const feed = await call("GET", `/groups/${feedGroupId}/audit-logs?limit=100`, owner);
    expect(feed.statusCode).toBe(200);
    const actions = (feed.json().events as { action: string }[]).map((e) => e.action);

    for (const action of [
      "group.create",
      "group.invite_code_create",
      "group.invite",
      "group.join",
      "webhook.register",
      "webhook.deregister",
    ]) {
      expect(actions).toContain(action);
    }

    // The webhook is gone; only the audit trail records which endpoint stopped
    // receiving the group's events.
    const hookEvent = (feed.json().events as any[]).find(
      (e) => e.action === "webhook.deregister"
    );
    expect(hookEvent.entityType).toBe("webhook");
    expect(hookEvent.entityId).toBe(hookId);
  });

  it("attributes a member's own departure", async () => {
    const left = await call("POST", `/groups/${feedGroupId}/leave`, joiner);
    expect(left.statusCode).toBe(200);
    expect(await auditActions(feedGroupId)).toContain("group.leave");
  });

  it("attributes archiving to the group that was archived", async () => {
    const archived = await call("POST", `/groups/${feedGroupId}/archive`, owner);
    expect(archived.statusCode).toBe(200);

    // The feed is still readable afterwards: `requireMembership` refuses an
    // archived group only to callers who are not members, and the archiving
    // admin remains one — so the event can be read back from the same endpoint
    // the archive closed to everyone else.
    const feed = await call("GET", `/groups/${feedGroupId}/audit-logs?limit=100`, owner);
    expect(feed.statusCode).toBe(200);
    const actions = (feed.json().events as { action: string }[]).map((e) => e.action);
    expect(actions).toContain("group.archive");
    expect(actions).toContain("group.leave");
  });
});

/**
 * Issue #648 — an archived group stays readable to its members but is closed to
 * new state. Every mutation route must answer 403 for a member of a group whose
 * `archived` flag is set, while reads of that same group keep returning 200.
 *
 * A mocked `src/db` cannot prove this ordering matters: it hands back whatever
 * the test sets, so it happily runs the handler past a guard that should have
 * stopped the request. Driving the real HTTP path against Postgres is what
 * shows the guard fires *before* the expense/settlement row is written, and
 * that the write the route would otherwise perform never reaches the database.
 */
describe("archived-group mutation lockout on a real Postgres (#648)", () => {
  let closedGroupId: string;
  let closedExpenseId: string;

  it("archives a group that still has an open expense", async () => {
    const g = await call("POST", "/groups", owner, { name: "Closed Book" });
    expect(g.statusCode).toBe(200);
    closedGroupId = g.json().group.id;

    // `member` has to be a real member before anything is asserted, so that a
    // later 403 can only be about archival, never about membership.
    const invite = await call("POST", `/groups/${closedGroupId}/invite`, owner, {
      maxUses: 5,
    });
    expect(invite.statusCode).toBe(200);
    const joined = await call("POST", "/groups/join", member, {
      code: invite.json().invite.code,
    });
    expect(joined.statusCode).toBe(200);

    const e = await call("POST", `/groups/${closedGroupId}/expenses`, owner, {
      title: "Open before archive",
      amount: EXPENSE_AMOUNT,
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: owner.id }, { userId: member.id }],
    });
    expect(e.statusCode).toBe(200);
    closedExpenseId = e.json().expense.id;

    const a = await call("POST", `/groups/${closedGroupId}/archive`, owner);
    expect(a.statusCode).toBe(200);
    expect(
      await prisma.group.findUniqueOrThrow({
        where: { id: closedGroupId },
        select: { archived: true },
      })
    ).toMatchObject({ archived: true });
  });

  it("refuses a new expense, and the row count is unchanged", async () => {
    const res = await call("POST", `/groups/${closedGroupId}/expenses`, owner, {
      title: "Too late",
      amount: EXPENSE_AMOUNT,
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId: owner.id }, { userId: member.id }],
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toMatch(/archived/i);
    // Only the pre-archive expense survives.
    expect(await prisma.expense.count({ where: { groupId: closedGroupId } })).toBe(1);
  });

  it("refuses a settlement built against the archived group", async () => {
    const res = await call("POST", `/groups/${closedGroupId}/settlements`, member, {
      toUserId: owner.id,
      amount: "1.0000000",
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(403);
    expect(await prisma.settlement.count({ where: { groupId: closedGroupId } })).toBe(0);
  });

  it("refuses to update or delete the expense that already exists", async () => {
    const patch = await call("PATCH", `/expenses/${closedExpenseId}`, owner, {
      title: "Renamed after archive",
    });
    expect(patch.statusCode).toBe(403);

    const del = await call("DELETE", `/expenses/${closedExpenseId}`, owner);
    expect(del.statusCode).toBe(403);

    // Both refusals left the expense in place.
    expect(await prisma.expense.count({ where: { id: closedExpenseId } })).toBe(1);
  });

  it("still lets members read the archived group's expenses and balances", async () => {
    const list = await call("GET", `/groups/${closedGroupId}/expenses`, member);
    expect(list.statusCode).toBe(200);
    expect(list.json().expenses).toHaveLength(1);

    const balances = await call("GET", `/groups/${closedGroupId}/balances`, member);
    expect(balances.statusCode).toBe(200);
  });
});
