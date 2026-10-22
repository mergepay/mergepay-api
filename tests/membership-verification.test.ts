/**
 * Issue #843 — Unit tests for group membership and role verification middleware.
 *
 * Verifies that the membership verification middleware (src/middleware/group-guard.ts
 * and src/plugins/group-access.ts) correctly enforces access control on group and
 * expense routes.
 *
 * Acceptance Criteria verified:
 *   - Unauthorized users receive 403 Forbidden on protected routes
 *   - Regular members cannot access admin-only endpoints
 *   - Admins can access both member and admin endpoints
 *   - Non-existent groups return 404 Not Found
 *   - Expense-based group resolution works correctly
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import { signToken } from "../src/plugins/auth";
import authPlugin from "../src/plugins/auth";
import errorHandlerPlugin from "../src/plugins/error-handler";
import groupAccessPlugin from "../src/plugins/group-access";
import {
  requireGroupMember,
  requireGroupAdmin,
  groupMembership,
} from "../src/middleware/group-guard";

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
  const roles = new Map<string, string>();
  return { prisma, roles };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

let userSeq = 0;
function newUser(role: string | null, group = "group_test_1"): string {
  userSeq += 1;
  const id = `user_test_${userSeq}`;
  if (role) h.roles.set(`${group}:${id}`, role);
  return id;
}

function bearer(userId: string) {
  return { authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: "GTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTESTTEST" })}` };
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
    ["group_test_1", "group_test_2"].includes(args?.where?.id)
      ? {
          id: args.where.id,
          name: "Test Group",
          description: null,
          createdByUserId: "user_creator",
          treasuryEnabled: false,
          treasuryAccountPublicKey: null,
          treasuryRequiredSigners: null,
          archived: false,
          createdAt: new Date("2026-01-01T00:00:00Z"),
        }
      : null
  );
  h.prisma.group.update.mockImplementation(async (args: any) => ({
    id: args?.where?.id ?? "group_test_1",
    name: args?.data?.name ?? "Test Group",
    description: null,
    createdByUserId: "user_creator",
    treasuryEnabled: args?.data?.treasuryEnabled ?? false,
    treasuryAccountPublicKey: args?.data?.treasuryAccountPublicKey ?? null,
    treasuryRequiredSigners: args?.data?.treasuryRequiredSigners ?? null,
    archived: false,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  }));
  h.prisma.expense.findUnique.mockReset();
});

async function buildTestApp() {
  const testApp = Fastify();
  await testApp.register(authPlugin);
  await testApp.register(errorHandlerPlugin);
  await testApp.register(groupAccessPlugin);

  const memberHandler = vi.fn(async (req: any) => ({
    message: "member ok",
    membership: groupMembership(req),
  }));

  const adminHandler = vi.fn(async (req: any) => ({
    message: "admin ok",
    membership: groupMembership(req),
  }));

  await testApp.register(async (scoped) => {
    scoped.addHook("preHandler", scoped.authenticate);

    scoped.get("/test/member/:id", { preHandler: requireGroupMember({ param: "id" }) }, memberHandler);
    scoped.post("/test/admin/:id", { preHandler: requireGroupAdmin({ param: "id" }) }, adminHandler);
    scoped.get("/test/expense/:id", { preHandler: requireGroupMember({ param: "id", fromExpense: true }) }, memberHandler);
  });

  await testApp.ready();
  return { testApp, memberHandler, adminHandler };
}

describe("Group Membership Verification Tests", () => {
  const GROUP_ID = "group_test_1";

  it("rejects non-members with 403 Forbidden", async () => {
    const { testApp, memberHandler } = await buildTestApp();
    const nonMember = newUser(null);

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
      headers: bearer(nonMember),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(memberHandler).not.toHaveBeenCalled();
  });

  it("admits regular group members", async () => {
    const { testApp, memberHandler } = await buildTestApp();
    const memberId = newUser("member");

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
      headers: bearer(memberId),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("member ok");
    expect(memberHandler).toHaveBeenCalledOnce();
  });

  it("admits group admins for member routes", async () => {
    const { testApp, memberHandler } = await buildTestApp();
    const adminId = newUser("admin");

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
      headers: bearer(adminId),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().membership.role).toBe("admin");
  });

  it("rejects regular members on admin routes with 403", async () => {
    const { testApp, adminHandler } = await buildTestApp();
    const memberId = newUser("member");

    const res = await testApp.inject({
      method: "POST",
      url: `/test/admin/${GROUP_ID}`,
      headers: bearer(memberId),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(adminHandler).not.toHaveBeenCalled();
  });

  it("admits administrators to admin routes", async () => {
    const { testApp, adminHandler } = await buildTestApp();
    const adminId = newUser("admin");

    const res = await testApp.inject({
      method: "POST",
      url: `/test/admin/${GROUP_ID}`,
      headers: bearer(adminId),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe("admin ok");
  });

  it("resolves group from expense row when fromExpense is true", async () => {
    const { testApp, memberHandler } = await buildTestApp();
    const expenseId = "exp_test_1";
    h.prisma.expense.findUnique.mockResolvedValue({ groupId: GROUP_ID });

    const memberId = newUser("member");
    const res = await testApp.inject({
      method: "GET",
      url: `/test/expense/${expenseId}`,
      headers: bearer(memberId),
    });

    expect(res.statusCode).toBe(200);
    expect(memberHandler).toHaveBeenCalledOnce();
  });

  it("returns 404 when target group does not exist", async () => {
    const { testApp, memberHandler } = await buildTestApp();
    const callerId = newUser(null);

    const res = await testApp.inject({
      method: "GET",
      url: "/test/member/missing_group_id",
      headers: bearer(callerId),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect(memberHandler).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const { testApp, memberHandler } = await buildTestApp();

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
    });

    expect(res.statusCode).toBe(401);
    expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
    expect(memberHandler).not.toHaveBeenCalled();
  });
});
