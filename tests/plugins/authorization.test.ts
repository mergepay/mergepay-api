/**
 * Reusable group authorization guards (issue #356).
 *
 * The first suite exercises `groupMemberGuard` / `groupAdminGuard` in
 * isolation on a bare Fastify instance — the 403/404 policy, the admin role
 * gate, and the unauthenticated path — so a failure here points at the
 * guard itself.
 *
 * The second suite drives the real app and pins the wiring: a denial must
 * land before the route handler opens its transaction, which is the only
 * observable difference between "the preHandler guard rejected this" and
 * "the handler's own in-transaction check rejected this".
 *
 * The database is mocked and Horizon never contacted — this suite runs
 * offline like the rest of the tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { FastifyInstance } from "fastify";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    invite: model(),
    invitation: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import authorizationPlugin, {
  groupIdFromExpense,
} from "../../src/plugins/authorization";
import errorHandlerPlugin from "../../src/plugins/error-handler";
import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";

const prisma = h.prisma;

const GROUP_ID = "group_1";
const EXPENSE_ID = "exp_1";
const VALID_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/**
 * Membership table keyed by "groupId:userId". `groupExists` drives the
 * 404-vs-403 probe `requireMembership` runs when no row is found.
 */
function arrange(
  rows: Record<string, "admin" | "member">,
  groupExists = true
) {
  prisma.groupMember.findUnique.mockImplementation(
    async ({ where }: any) => {
      const { groupId, userId } = where.groupId_userId;
      const role = rows[`${groupId}:${userId}`];
      return role ? { groupId, userId, role } : null;
    }
  );
  prisma.group.findUnique.mockImplementation(async () =>
    groupExists ? { id: GROUP_ID } : null
  );
}

function authHeader(userId: string) {
  const token = signToken({ id: userId, stellarPublicKey: VALID_KEY });
  return { authorization: `Bearer ${token}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg)
  );
});

// ---------------------------------------------------------------------------
// The guards in isolation
// ---------------------------------------------------------------------------

/**
 * A bare instance carrying exactly what the guards depend on: an
 * error handler that renders `AppError`s, the guard plugin, and a stand-in
 * for `app.authenticate` that reads the caller from a header — so each test
 * picks its caller without paying for real JWT verification.
 */
async function buildGuardApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(authorizationPlugin);

  app.addHook("preHandler", async (req) => {
    const userId = req.headers["x-user-id"];
    if (typeof userId === "string" && userId) {
      req.user = { id: userId, stellarPublicKey: VALID_KEY };
    }
  });

  app.get(
    "/groups/:id",
    { preHandler: [app.groupMemberGuard()] },
    async () => ({ ok: true })
  );
  app.delete(
    "/groups/:id/members/:memberId",
    { preHandler: [app.groupAdminGuard()] },
    async () => ({ ok: true })
  );
  app.get(
    "/expenses/:id",
    { preHandler: [app.groupMemberGuard({ groupId: groupIdFromExpense })] },
    async () => ({ ok: true })
  );

  await app.ready();
  return app;
}

describe("authorization guards (unit)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildGuardApp();
  });

  it("lets a member through a membership-guarded route", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: { "x-user-id": "member" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("answers 403 FORBIDDEN for a non-member", async () => {
    arrange({}, true);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: { "x-user-id": "outsider" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(res.json().message).toBe("You are not a member of this group");
  });

  it("keeps the 404-for-unknown-group distinction on guarded routes", async () => {
    arrange({}, false);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: { "x-user-id": "outsider" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("answers 403 for a member who is not an admin on an admin-guarded route", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/user_target`,
      headers: { "x-user-id": "member" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe(
      "Only a group admin can perform this action"
    );
  });

  it("lets an admin through an admin-guarded route", async () => {
    arrange({ [`${GROUP_ID}:root`]: "admin" });

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/user_target`,
      headers: { "x-user-id": "root" },
    });

    expect(res.statusCode).toBe(200);
  });

  it("gates an admin-guarded route on membership first", async () => {
    arrange({}, true);

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/user_target`,
      headers: { "x-user-id": "outsider" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().message).toBe(
      "You are not a member of this group"
    );
  });

  it("answers 401 — and reads nothing — for an unauthenticated caller", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
    });

    expect(res.statusCode).toBe(401);
    expect(prisma.groupMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.expense.findUnique).not.toHaveBeenCalled();
  });

  it("resolves the group from the expense row on expense-guarded routes", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });
    prisma.expense.findUnique.mockResolvedValue({ groupId: GROUP_ID });

    const res = await app.inject({
      method: "GET",
      url: `/expenses/${EXPENSE_ID}`,
      headers: { "x-user-id": "member" },
    });

    expect(res.statusCode).toBe(200);
    // Only the group id is read — payer, shares, and amounts stay out of it.
    expect(prisma.expense.findUnique).toHaveBeenCalledWith({
      where: { id: EXPENSE_ID },
      select: { groupId: true },
    });
  });

  it("404s an unknown expense before any membership question is asked", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });
    prisma.expense.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: "GET",
      url: `/expenses/${EXPENSE_ID}`,
      headers: { "x-user-id": "member" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().message).toBe("Expense not found");
    expect(prisma.groupMember.findUnique).not.toHaveBeenCalled();
  });

  it("403s a non-member of the expense's group", async () => {
    arrange({}, true);
    prisma.expense.findUnique.mockResolvedValue({ groupId: GROUP_ID });

    const res = await app.inject({
      method: "GET",
      url: `/expenses/${EXPENSE_ID}`,
      headers: { "x-user-id": "outsider" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });
});

// ---------------------------------------------------------------------------
// The guards wired to the real routes
// ---------------------------------------------------------------------------

describe("guards applied to group and expense routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    if (!app) app = await buildApp();
    prisma.group.update.mockResolvedValue({
      id: GROUP_ID,
      name: "Trip",
      description: null,
      createdByUserId: "admin",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.expense.update.mockResolvedValue({ id: EXPENSE_ID });
    prisma.auditLog.create.mockResolvedValue({});
  });

  it("rejects a non-admin on POST /groups/:id/archive before the handler's transaction opens", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/archive`,
      headers: authHeader("member"),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    // The handler archives inside a transaction; a guard denial happens
    // before the handler runs, so no transaction is ever opened.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("rejects a non-member on POST /groups/:id/leave before the handler's transaction opens", async () => {
    arrange({}, true);

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/leave`,
      headers: authHeader("outsider"),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("rejects a non-member on GET /groups/:id before the handler reads the group", async () => {
    arrange({}, true);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: authHeader("outsider"),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("lets an admin archive through the guard", async () => {
    arrange({ [`${GROUP_ID}:admin`]: "admin" });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/archive`,
      headers: authHeader("admin"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().group.archived).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("rejects a non-member on PATCH /expenses/:id before the handler's transaction opens", async () => {
    arrange({}, true);
    prisma.expense.findUnique.mockResolvedValue({ groupId: GROUP_ID });

    const res = await app.inject({
      method: "PATCH",
      url: `/expenses/${EXPENSE_ID}`,
      headers: authHeader("outsider"),
      payload: { title: "Renamed" },
    });

    expect(res.statusCode).toBe(403);
    // Proof the guard — not the handler — denied this: the guard's resolver
    // read the expense (selecting only groupId), while the handler's own
    // read would have happened inside a transaction that never opened.
    expect(prisma.expense.findUnique).toHaveBeenCalledWith({
      where: { id: EXPENSE_ID },
      select: { groupId: true },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.expense.update).not.toHaveBeenCalled();
  });

  it("rejects a non-member on POST /groups/:id/expenses before anything is written", async () => {
    arrange({}, true);

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader("outsider"),
      payload: {
        title: "Dinner",
        amount: "100",
        assetCode: "XLM",
        splitType: "equal",
        shares: [{ userId: "outsider" }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.expense.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("still admits a member to the expense routes", async () => {
    arrange({ [`${GROUP_ID}:member`]: "member" });
    // One standing row: the guard's resolver reads the group id from it, the
    // handler re-reads it inside its transaction (as payer, so its edit is
    // allowed) and serializes payer and shares out of the same object.
    const expenseRow = {
      id: EXPENSE_ID,
      groupId: GROUP_ID,
      payerUserId: "member",
      title: "Dinner",
      description: null,
      memo: null,
      receiptUrl: null,
      amount: "10.00",
      assetCode: "XLM",
      assetIssuer: null,
      splitType: "equal",
      createdAt: new Date(),
      payer: {
        id: "member",
        stellarPublicKey: VALID_KEY,
        displayName: "Member",
        avatarUrl: null,
        createdAt: new Date(),
      },
      shares: [],
    };
    prisma.expense.findUnique.mockResolvedValue(expenseRow);
    prisma.expense.update.mockResolvedValue({
      ...expenseRow,
      title: "Renamed",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/expenses/${EXPENSE_ID}`,
      headers: authHeader("member"),
      payload: { title: "Renamed" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
