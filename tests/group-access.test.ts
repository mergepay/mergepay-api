/**
 * Issue #532 — centralized group membership / role authorization.
 *
 * Three layers:
 *  1. `requireGroupRole` on a minimal Fastify app: every membership and role
 *     outcome, escalation attempts via body / query / headers, and the
 *     programming-error path.
 *  2. The real app: every group-scoped route (the table below) rejects a
 *     non-member and an insufficient role with 403 before its handler runs,
 *     and admits the role it requires.
 *  3. An inventory check that scans src/routes for `/groups/:...` routes, so
 *     a new group route cannot be added without joining the table (and
 *     therefore without being exercised by layer 2).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    invite: model(),
    invitation: model(),
    auditLog: model(),
    idempotencyKey: model(),
    webhook: model(),
    webhookDelivery: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 0),
    $disconnect: vi.fn(),
  };
  /** userId → role in GROUP_ID; absent means "not a member". */
  const roles = new Map<string, string>();
  return { prisma, roles };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import authPlugin from "../src/plugins/auth";
import errorHandlerPlugin from "../src/plugins/error-handler";
import groupAccessPlugin, {
  groupMembership,
  requireGroupRole,
} from "../src/plugins/group-access";

const GROUP_ID = "group_1";
const OTHER_GROUP_ID = "group_2";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let userSeq = 0;
/** A fresh user id per scenario, so per-user rate-limit buckets never collide. */
function newUser(role: string | null, group = GROUP_ID): string {
  userSeq += 1;
  const id = `user_${userSeq}`;
  if (role) h.roles.set(`${group}:${id}`, role);
  return id;
}

function bearer(userId: string) {
  return { authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}` };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.roles.clear();
  h.prisma.$transaction.mockImplementation(async (arg: any) =>
    typeof arg === "function" ? arg(h.prisma) : Promise.all(arg)
  );
  h.prisma.groupMember.findUnique.mockImplementation(async (args: any) => {
    const key = args?.where?.groupId_userId;
    if (!key) return null;
    const role = h.roles.get(`${key.groupId}:${key.userId}`);
    return role ? { groupId: key.groupId, userId: key.userId, role } : null;
  });
  h.prisma.group.findUnique.mockImplementation(async (args: any) =>
    [GROUP_ID, OTHER_GROUP_ID].includes(args?.where?.id)
      ? { id: args.where.id, name: "Trip", archived: false, treasuryEnabled: false }
      : null
  );
  h.prisma.expense.findUnique.mockReset();
});

// ---------------------------------------------------------------------------
// 1. The guard in isolation
// ---------------------------------------------------------------------------

async function guardApp() {
  const app = Fastify();
  await app.register(authPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(groupAccessPlugin);
  const handler = vi.fn(async (req: any) => ({ membership: groupMembership(req) }));
  await app.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);
    scoped.post("/m/:id", { preHandler: requireGroupRole("member", { param: "id" }) }, handler);
    scoped.post("/a/:groupId", { preHandler: requireGroupRole("admin", { param: "groupId" }) }, handler);
    scoped.get(
      "/e/:id",
      { preHandler: requireGroupRole("member", { param: "id", fromExpense: true }) },
      handler
    );
    scoped.get("/unguarded/:id", async (req) => ({ membership: groupMembership(req) }));
  });
  await app.ready();
  return { app, handler };
}

describe("requireGroupRole — membership", () => {
  it("rejects a non-member with 403 and never runs the handler", async () => {
    const { app, handler } = await guardApp();
    const res = await app.inject({ method: "POST", url: `/m/${GROUP_ID}`, headers: bearer(newUser(null)) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 404 when the group does not exist", async () => {
    const { app, handler } = await guardApp();
    const res = await app.inject({ method: "POST", url: "/m/group_missing", headers: bearer(newUser(null)) });
    expect(res.statusCode).toBe(404);
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits a regular member and attaches the verified membership", async () => {
    const { app } = await guardApp();
    const userId = newUser("member");
    const res = await app.inject({ method: "POST", url: `/m/${GROUP_ID}`, headers: bearer(userId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toEqual({ groupId: GROUP_ID, userId, role: "member" });
  });

  it("admits an admin on a member route (admin implies member)", async () => {
    const { app } = await guardApp();
    const res = await app.inject({ method: "POST", url: `/m/${GROUP_ID}`, headers: bearer(newUser("admin")) });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership.role).toBe("admin");
  });

  it("rejects an unauthenticated request with 401 before any lookup", async () => {
    const { app } = await guardApp();
    const res = await app.inject({ method: "POST", url: `/m/${GROUP_ID}` });
    expect(res.statusCode).toBe(401);
    expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
  });

  it("rejects a malformed (oversized) group id with 400 before any lookup", async () => {
    const { app } = await guardApp();
    const res = await app.inject({
      method: "POST",
      url: `/m/${"g".repeat(65)}`,
      headers: bearer(newUser("admin")),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
  });
});

describe("requireGroupRole — roles", () => {
  it("admits an admin on an admin route", async () => {
    const { app, handler } = await guardApp();
    const res = await app.inject({ method: "POST", url: `/a/${GROUP_ID}`, headers: bearer(newUser("admin")) });
    expect(res.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects a regular member on an admin route (insufficient role)", async () => {
    const { app, handler } = await guardApp();
    const res = await app.inject({ method: "POST", url: `/a/${GROUP_ID}`, headers: bearer(newUser("member")) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.message).toBe("Only a group admin can perform this action");
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["Admin", "ADMIN", "owner", "superuser", ""])(
    "never treats a stored role of %j as admin",
    async (storedRole) => {
      const { app, handler } = await guardApp();
      const userId = newUser(null);
      h.roles.set(`${GROUP_ID}:${userId}`, storedRole || "unknown");
      const res = await app.inject({ method: "POST", url: `/a/${GROUP_ID}`, headers: bearer(userId) });
      expect(res.statusCode).toBe(403);
      expect(handler).not.toHaveBeenCalled();
    }
  );
});

describe("requireGroupRole — escalation and bypass attempts", () => {
  it("ignores a role claimed in the body, query string, or headers", async () => {
    const { app, handler } = await guardApp();
    const res = await app.inject({
      method: "POST",
      url: `/a/${GROUP_ID}?role=admin&isAdmin=true`,
      headers: { ...bearer(newUser("member")), "x-role": "admin", "x-group-role": "admin" },
      payload: { role: "admin", groupMembership: { role: "admin" } },
    });
    expect(res.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it("authorizes against the path group only, never a group id in the body or query", async () => {
    const { app, handler } = await guardApp();
    // Admin of OTHER_GROUP_ID, plain member of GROUP_ID.
    const userId = newUser("member");
    h.roles.set(`${OTHER_GROUP_ID}:${userId}`, "admin");

    const res = await app.inject({
      method: "POST",
      url: `/a/${GROUP_ID}?groupId=${OTHER_GROUP_ID}&id=${OTHER_GROUP_ID}`,
      headers: bearer(userId),
      payload: { groupId: OTHER_GROUP_ID, id: OTHER_GROUP_ID },
    });

    expect(res.statusCode).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    for (const [args] of h.prisma.groupMember.findUnique.mock.calls) {
      expect(args.where.groupId_userId.groupId).toBe(GROUP_ID);
    }
  });

  it("does not trust a token for a different user (role follows the token's subject)", async () => {
    const { app } = await guardApp();
    newUser("admin"); // an admin exists…
    const outsider = newUser(null); // …but the token belongs to a non-member
    const res = await app.inject({ method: "POST", url: `/a/${GROUP_ID}`, headers: bearer(outsider) });
    expect(res.statusCode).toBe(403);
  });

  it("fails loudly (500) if a handler reads membership on a route without the guard", async () => {
    const { app } = await guardApp();
    const res = await app.inject({ method: "GET", url: `/unguarded/${GROUP_ID}`, headers: bearer(newUser("admin")) });
    expect(res.statusCode).toBe(500);
  });
});

describe("requireGroupRole — fromExpense (routes addressed by an expense id)", () => {
  const EXPENSE_ID = "expense_1";

  it("resolves the group from the expense row and admits a member", async () => {
    const { app } = await guardApp();
    h.prisma.expense.findUnique.mockResolvedValue({ groupId: GROUP_ID });
    const userId = newUser("member");
    const res = await app.inject({ method: "GET", url: `/e/${EXPENSE_ID}`, headers: bearer(userId) });
    expect(res.statusCode).toBe(200);
    expect(res.json().membership).toEqual({ groupId: GROUP_ID, userId, role: "member" });
    expect(h.prisma.expense.findUnique).toHaveBeenCalledWith({
      where: { id: EXPENSE_ID },
      select: { groupId: true },
    });
  });

  it("rejects a non-member with 403 and never runs the handler", async () => {
    const { app, handler } = await guardApp();
    h.prisma.expense.findUnique.mockResolvedValue({ groupId: GROUP_ID });
    const res = await app.inject({ method: "GET", url: `/e/${EXPENSE_ID}`, headers: bearer(newUser(null)) });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown expense before any membership lookup", async () => {
    const { app, handler } = await guardApp();
    h.prisma.expense.findUnique.mockResolvedValue(null);
    const res = await app.inject({ method: "GET", url: "/e/expense_missing", headers: bearer(newUser("admin")) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a malformed (oversized) expense id with 400 before any lookup", async () => {
    const { app } = await guardApp();
    const res = await app.inject({
      method: "GET",
      url: `/e/${"e".repeat(65)}`,
      headers: bearer(newUser("member")),
    });
    expect(res.statusCode).toBe(400);
    expect(h.prisma.expense.findUnique).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request with 401 before any lookup", async () => {
    const { app } = await guardApp();
    const res = await app.inject({ method: "GET", url: `/e/${EXPENSE_ID}` });
    expect(res.statusCode).toBe(401);
    expect(h.prisma.expense.findUnique).not.toHaveBeenCalled();
  });
});

describe("groupAccessPlugin — guard ordering", () => {
  it("moves the guard after preHandlers appended later (e.g. the rate limiter)", async () => {
    const order: string[] = [];
    const app = Fastify();
    await app.register(authPlugin);
    await app.register(errorHandlerPlugin);
    // Stand-in for @fastify/rate-limit: appends its preHandler in onRoute.
    app.addHook("onRoute", (route) => {
      if ((route.config as any)?.limited) {
        const limiter = async () => {
          order.push("limiter");
        };
        route.preHandler = Array.isArray(route.preHandler)
          ? [...route.preHandler, limiter]
          : route.preHandler
            ? [route.preHandler, limiter]
            : [limiter];
      }
    });
    await app.register(groupAccessPlugin);
    const guard = requireGroupRole("member", { param: "id" });
    app.post(
      "/x/:id",
      {
        config: { limited: true } as any,
        preHandler: [
          app.authenticate,
          async (req: any, reply: any) => {
            order.push("guard");
            return guard.call(app, req, reply);
          },
        ],
      },
      async () => {
        order.push("handler");
        return { ok: true };
      }
    );
    // The wrapper above is not marked, so mark-based ordering is tested with
    // the real guard below; this route documents the unmarked baseline.
    app.post(
      "/y/:id",
      { config: { limited: true } as any, preHandler: [app.authenticate, guard] },
      async () => ({ ok: true })
    );
    await app.ready();

    await app.inject({ method: "POST", url: `/x/${GROUP_ID}`, headers: bearer(newUser("member")) });
    // Unmarked wrapper keeps declaration order: guard, then limiter.
    expect(order).toEqual(["guard", "limiter", "handler"]);

    order.length = 0;
    h.prisma.groupMember.findUnique.mockImplementationOnce(async () => {
      order.push("guard-lookup");
      return { groupId: GROUP_ID, userId: "u", role: "member" };
    });
    const res = await app.inject({ method: "POST", url: `/y/${GROUP_ID}`, headers: bearer(newUser("member")) });
    expect(res.statusCode).toBe(200);
    // The real (marked) guard is moved behind the limiter.
    expect(order).toEqual(["limiter", "guard-lookup"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Every group route on the real app
// ---------------------------------------------------------------------------

type Role = "member" | "admin";
interface GroupRoute {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  role: Role;
}

/** Every route addressed by a group id in its path, with the role it requires. */
const GROUP_ROUTES: GroupRoute[] = [
  // src/routes/groups.ts
  { method: "GET", path: "/groups/:id/balance", role: "member" },
  { method: "GET", path: "/groups/:id", role: "member" },
  { method: "POST", path: "/groups/:id/invite", role: "admin" },
  { method: "POST", path: "/groups/:id/leave", role: "member" },
  { method: "PATCH", path: "/groups/:id/members/:memberId", role: "admin" },
  { method: "DELETE", path: "/groups/:id/members/:memberId", role: "admin" },
  { method: "POST", path: "/groups/:id/members/role", role: "admin" },
  { method: "POST", path: "/groups/:id/archive", role: "admin" },
  // src/routes/expenses.ts
  { method: "POST", path: "/groups/:id/expenses", role: "member" },
  { method: "GET", path: "/groups/:id/expenses", role: "member" },
  // src/routes/settlements.ts
  { method: "POST", path: "/groups/:id/settlements", role: "member" },
  { method: "GET", path: "/groups/:id/settlements", role: "member" },
  { method: "GET", path: "/groups/:id/settlement/preview", role: "member" },
  { method: "GET", path: "/groups/:id/balances", role: "member" },
  { method: "GET", path: "/groups/:id/ledger", role: "member" },
  // src/routes/treasury.ts
  { method: "POST", path: "/groups/:id/treasury/enable", role: "admin" },
  { method: "GET", path: "/groups/:id/treasury", role: "member" },
  { method: "POST", path: "/groups/:id/treasury/validate-signers", role: "admin" },
  { method: "POST", path: "/groups/:id/treasury/deposit", role: "member" },
  { method: "POST", path: "/groups/:id/treasury/withdraw", role: "member" },
  { method: "GET", path: "/groups/:id/treasury/history", role: "member" },
  // src/routes/treasury-proposals.ts
  { method: "POST", path: "/groups/:groupId/treasury/proposals", role: "admin" },
  { method: "GET", path: "/groups/:groupId/treasury/proposals", role: "member" },
  { method: "POST", path: "/groups/:groupId/treasury/proposals/:proposalId/sign", role: "member" },
  { method: "GET", path: "/groups/:groupId/treasury/status", role: "member" },
  // src/routes/webhooks.ts
  { method: "POST", path: "/groups/:groupId/webhooks", role: "member" },
  { method: "GET", path: "/groups/:groupId/webhooks", role: "member" },
  { method: "DELETE", path: "/groups/:groupId/webhooks/:webhookId", role: "admin" },
  { method: "POST", path: "/groups/:groupId/webhooks/:webhookId/test", role: "member" },
  { method: "GET", path: "/groups/:groupId/webhooks/:webhookId/deliveries", role: "member" },
  // src/routes/audit-log.ts
  { method: "GET", path: "/groups/:groupId/audit-logs", role: "member" },
  { method: "GET", path: "/groups/:groupId/audit-log", role: "admin" },
];

function concreteUrl(routePath: string, groupId = GROUP_ID): string {
  return routePath
    .replace(/:(id|groupId)(?=\/|$)/, groupId)
    .replace(":memberId", "user_target")
    .replace(":proposalId", "prop_1")
    .replace(":webhookId", "wh_1");
}

/** Mutations that must never happen when the guard rejects a request. */
function writes() {
  const p = h.prisma;
  return [
    p.group.create, p.group.update, p.groupMember.create, p.groupMember.update,
    p.groupMember.delete, p.invitation.create, p.invite.create, p.expense.create,
    p.settlement.create, p.treasuryTransaction.create, p.treasuryProposal.create,
    p.webhook.create, p.webhook.delete, p.auditLog.create, p.$transaction,
  ].reduce((n, fn) => n + fn.mock.calls.length, 0);
}

let realApp: Awaited<ReturnType<typeof buildApp>>;
async function app() {
  if (!realApp) realApp = await buildApp();
  return realApp;
}

describe("group routes on the real app", () => {
  it.each(GROUP_ROUTES)("$method $path — non-member gets 403 before the handler", async (route) => {
    const res = await (await app()).inject({
      method: route.method,
      url: concreteUrl(route.path),
      headers: bearer(newUser(null)),
      payload: route.method === "GET" ? undefined : { role: "admin" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(writes()).toBe(0);
  });

  it.each(GROUP_ROUTES.filter((r) => r.role === "admin"))(
    "$method $path — regular member gets 403 (admin required)",
    async (route) => {
      const res = await (await app()).inject({
        method: route.method,
        url: concreteUrl(route.path),
        headers: bearer(newUser("member")),
        payload: route.method === "GET" ? undefined : { role: "admin", userId: "user_target" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.message).toBe("Only a group admin can perform this action");
      expect(writes()).toBe(0);
    }
  );

  it.each(GROUP_ROUTES)("$method $path — required role ($role) passes the guard", async (route) => {
    const res = await (await app()).inject({
      method: route.method,
      url: concreteUrl(route.path),
      headers: bearer(newUser(route.role)),
      payload: route.method === "GET" ? undefined : {},
    });
    // Handlers may fail downstream on mocked data (400/404/409/500), but the
    // guard itself must not refuse the required role.
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).not.toBe(401);
  });

  it.each(GROUP_ROUTES)("$method $path — unknown group returns 404", async (route) => {
    const res = await (await app()).inject({
      method: route.method,
      url: concreteUrl(route.path, "group_missing"),
      headers: bearer(newUser(null)),
      payload: route.method === "GET" ? undefined : {},
    });
    expect(res.statusCode).toBe(404);
    expect(writes()).toBe(0);
  });

  it("rate-limits a non-member hammering a limited group route before the guard's lookup", async () => {
    const a = await app();
    const outsider = newUser(null);
    const url = concreteUrl("/groups/:id/treasury/deposit");
    let status = 0;
    let lookupsAtLimit = -1;
    for (let i = 0; i < 200 && status !== 429; i++) {
      const res = await a.inject({ method: "POST", url, headers: bearer(outsider), payload: {} });
      status = res.statusCode;
      if (status === 429) lookupsAtLimit = h.prisma.groupMember.findUnique.mock.calls.length;
      else expect(status).toBe(403);
    }
    expect(status).toBe(429);
    // Further requests are refused by the limiter without touching the DB.
    await a.inject({ method: "POST", url, headers: bearer(outsider), payload: {} });
    expect(h.prisma.groupMember.findUnique.mock.calls.length).toBe(lookupsAtLimit);
  });
});

// ---------------------------------------------------------------------------
// 2b. Expense routes addressed by a single expense id on the real app
// ---------------------------------------------------------------------------

/** The three `/expenses/:id` routes guarded via `fromExpense`. */
const EXPENSE_GUARD_ROUTES = ["GET", "PATCH", "DELETE"] as const;

/** A complete expense row, so admitted requests serialize instead of crashing. */
function expenseRow() {
  return {
    id: "expense_1",
    groupId: GROUP_ID,
    payerUserId: "user_payer",
    payer: {
      id: "user_payer",
      stellarPublicKey: PUBLIC_KEY,
      displayName: "Payer",
      avatarUrl: null,
      createdAt: new Date(),
    },
    title: "Dinner",
    description: null,
    amount: "50.00",
    assetCode: "USDC",
    assetIssuer: null,
    splitType: "equal",
    memo: null,
    receiptUrl: null,
    createdAt: new Date(),
    shares: [],
  };
}

describe("expense routes on the real app", () => {
  beforeEach(() => {
    h.prisma.expense.findUnique.mockResolvedValue(expenseRow());
    h.prisma.expense.update.mockResolvedValue(expenseRow());
    h.prisma.expense.delete.mockResolvedValue(expenseRow());
  });

  it.each(EXPENSE_GUARD_ROUTES)(
    "%s /expenses/:id — non-member gets 403 before the handler",
    async (method) => {
      const res = await (await app()).inject({
        method,
        url: "/expenses/expense_1",
        headers: bearer(newUser(null)),
        payload: method === "GET" ? undefined : {},
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
      expect(writes()).toBe(0);
    }
  );

  it.each(EXPENSE_GUARD_ROUTES)(
    "%s /expenses/:id — unknown expense returns 404 without a membership lookup",
    async (method) => {
      h.prisma.expense.findUnique.mockResolvedValue(null);
      const res = await (await app()).inject({
        method,
        url: "/expenses/expense_missing",
        headers: bearer(newUser(null)),
        payload: method === "GET" ? undefined : {},
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("NOT_FOUND");
      expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
      expect(writes()).toBe(0);
    }
  );

  it.each(EXPENSE_GUARD_ROUTES)(
    "%s /expenses/:id — the required role passes the guard",
    async (method) => {
      // PATCH / DELETE also require payer-or-admin in the handler, so the
      // admitted caller is an admin there; the guard itself needs member+.
      const res = await (await app()).inject({
        method,
        url: "/expenses/expense_1",
        headers: bearer(newUser(method === "GET" ? "member" : "admin")),
        payload: method === "GET" ? undefined : {},
      });
      expect(res.statusCode).toBe(200);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. Inventory: no group route escapes the table above
// ---------------------------------------------------------------------------

describe("group route inventory", () => {
  it("every /groups/:param route in src/routes is covered by GROUP_ROUTES", () => {
    const dir = path.resolve(__dirname, "../src/routes");
    const found = new Set<string>();
    const routeRe = /app\.(get|post|put|patch|delete)\(\s*"(\/groups\/:[^"]+)"/g;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const source = readFileSync(path.join(dir, file), "utf8");
      for (const m of source.matchAll(routeRe)) {
        found.add(`${m[1].toUpperCase()} ${m[2]}`);
      }
    }
    const covered = new Set(GROUP_ROUTES.map((r) => `${r.method} ${r.path}`));
    expect([...found].sort()).toEqual([...covered].sort());
  });
});
