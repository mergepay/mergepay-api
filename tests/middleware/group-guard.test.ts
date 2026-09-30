/**
 * Issue #549 — Implement group membership and admin permission middleware guards for restricted routes.
 *
 * Verifies Fastify preHandler middleware guards (src/middleware/group-guard.ts):
 *   - requireGroupMember / requireMembershipGuard: checks membership
 *   - requireGroupAdmin / requireAdminGuard: checks admin privileges
 *
 * Acceptance Criteria verified:
 *   - Implement membership verification and admin-role verification preHandler hooks.
 *   - Apply guards to relevant group and treasury route definitions.
 *   - Confirm non-members and non-admins receive 403 responses while authorized users proceed.
 *   - Confirm unauthenticated requests receive 401 and non-existent groups return 404.
 */
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
  const roles = new Map<string, string>();
  return { prisma, roles };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
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

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import authPlugin from "../../src/plugins/auth";
import errorHandlerPlugin from "../../src/plugins/error-handler";
import groupAccessPlugin from "../../src/plugins/group-access";
import {
  requireGroupMember,
  requireGroupAdmin,
  requireMembershipGuard,
  requireAdminGuard,
  groupMembership,
} from "../../src/middleware/group-guard";

const GROUP_ID = "group_mid_1";
const OTHER_GROUP_ID = "group_mid_2";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

let userSeq = 0;
function newUser(role: string | null, group = GROUP_ID): string {
  userSeq += 1;
  const id = `user_mid_${userSeq}`;
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
      ? {
          id: args.where.id,
          name: "Trip",
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
    id: args?.where?.id ?? GROUP_ID,
    name: args?.data?.name ?? "Trip",
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

async function buildTestMiddlewareApp() {
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

    // Routes using requireGroupMember / requireMembershipGuard
    scoped.get("/test/member/:id", { preHandler: requireGroupMember({ param: "id" }) }, memberHandler);
    scoped.get(
      "/test/member-alias/:groupId",
      { preHandler: requireMembershipGuard({ param: "groupId" }) },
      memberHandler
    );

    // Routes using requireGroupAdmin / requireAdminGuard
    scoped.post("/test/admin/:id", { preHandler: requireGroupAdmin({ param: "id" }) }, adminHandler);
    scoped.post(
      "/test/admin-alias/:groupId",
      { preHandler: requireAdminGuard({ param: "groupId" }) },
      adminHandler
    );

    // Route addressed by expense id
    scoped.get(
      "/test/expense/:id",
      { preHandler: requireGroupMember({ param: "id", fromExpense: true }) },
      memberHandler
    );
  });

  await testApp.ready();
  return { testApp, memberHandler, adminHandler };
}

describe("group membership middleware guard (requireGroupMember / requireMembershipGuard)", () => {
  it("rejects non-members with 403 Forbidden and blocks handler execution", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();
    const nonMember = newUser(null);

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
      headers: bearer(nonMember),
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("You are not a member of this group");
    expect(memberHandler).not.toHaveBeenCalled();
  });

  it("admits regular group members and attaches req.groupMembership context", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();
    const memberId = newUser("member");

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
      headers: bearer(memberId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe("member ok");
    expect(body.membership).toEqual({
      groupId: GROUP_ID,
      userId: memberId,
      role: "member",
    });
    expect(memberHandler).toHaveBeenCalledOnce();
  });

  it("admits group admins since admin role satisfies membership requirement", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();
    const adminId = newUser("admin");

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
      headers: bearer(adminId),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.membership.role).toBe("admin");
    expect(memberHandler).toHaveBeenCalledOnce();
  });

  it("works with custom route param (groupId) and alias requireMembershipGuard", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();
    const memberId = newUser("member");

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member-alias/${GROUP_ID}`,
      headers: bearer(memberId),
    });

    expect(res.statusCode).toBe(200);
    expect(memberHandler).toHaveBeenCalledOnce();
  });

  it("resolves group from expense row when fromExpense is true", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();
    const expenseId = "exp_mid_1";
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
});

describe("group admin permission middleware guard (requireGroupAdmin / requireAdminGuard)", () => {
  it("rejects regular members on admin routes with 403 Forbidden", async () => {
    const { testApp, adminHandler } = await buildTestMiddlewareApp();
    const memberId = newUser("member");

    const res = await testApp.inject({
      method: "POST",
      url: `/test/admin/${GROUP_ID}`,
      headers: bearer(memberId),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toBe("Only a group admin can perform this action");
    expect(adminHandler).not.toHaveBeenCalled();
  });

  it("admits administrators to execute admin-protected actions", async () => {
    const { testApp, adminHandler } = await buildTestMiddlewareApp();
    const adminId = newUser("admin");

    const res = await testApp.inject({
      method: "POST",
      url: `/test/admin/${GROUP_ID}`,
      headers: bearer(adminId),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.message).toBe("admin ok");
    expect(body.membership.role).toBe("admin");
    expect(adminHandler).toHaveBeenCalledOnce();
  });

  it("works with custom route param (groupId) and alias requireAdminGuard", async () => {
    const { testApp, adminHandler } = await buildTestMiddlewareApp();
    const adminId = newUser("admin");

    const res = await testApp.inject({
      method: "POST",
      url: `/test/admin-alias/${GROUP_ID}`,
      headers: bearer(adminId),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(adminHandler).toHaveBeenCalledOnce();
  });
});

describe("group guards — error handling & validation", () => {
  it("rejects unauthenticated requests with 401 Unauthorized before any DB lookup", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${GROUP_ID}`,
    });

    expect(res.statusCode).toBe(401);
    expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
    expect(memberHandler).not.toHaveBeenCalled();
  });

  it("returns 404 Not Found when the target group does not exist", async () => {
    const { testApp, memberHandler } = await buildTestMiddlewareApp();
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

  it("rejects oversized/malformed group ID parameter with 400 Validation Error", async () => {
    const { testApp } = await buildTestMiddlewareApp();
    const callerId = newUser("admin");

    const res = await testApp.inject({
      method: "GET",
      url: `/test/member/${"x".repeat(65)}`,
      headers: bearer(callerId),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(h.prisma.groupMember.findUnique).not.toHaveBeenCalled();
  });
});

describe("group guards on real application endpoints (#549)", () => {
  let appInstance: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    if (!appInstance) appInstance = await buildApp();
  });

  it("enforces member access on GET /groups/:id", async () => {
    const outsider = newUser(null);
    const resForbidden = await appInstance.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: bearer(outsider),
    });
    expect(resForbidden.statusCode).toBe(403);

    const member = newUser("member");
    const resOk = await appInstance.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: bearer(member),
    });
    expect(resOk.statusCode).toBe(200);
  });

  it("enforces admin access on PATCH /groups/:id", async () => {
    const member = newUser("member");
    const resForbidden = await appInstance.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}`,
      headers: bearer(member),
      payload: { name: "Updated Name" },
    });
    expect(resForbidden.statusCode).toBe(403);
    expect(resForbidden.json().error.message).toBe("Only a group admin can perform this action");

    const admin = newUser("admin");
    h.prisma.group.update.mockResolvedValueOnce({
      id: GROUP_ID,
      name: "Updated Name",
      description: null,
      createdByUserId: admin,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date(),
    });
    const resOk = await appInstance.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}`,
      headers: bearer(admin),
      payload: { name: "Updated Name" },
    });
    expect(resOk.statusCode).toBe(200);
  });

  it("enforces admin access on POST /groups/:id/treasury/enable", async () => {
    const member = newUser("member");
    const resForbidden = await appInstance.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/treasury/enable`,
      headers: bearer(member),
      payload: { publicKey: PUBLIC_KEY },
    });
    expect(resForbidden.statusCode).toBe(403);

    const admin = newUser("admin");
    h.prisma.group.update.mockResolvedValueOnce({
      id: GROUP_ID,
      name: "Treasury Group",
      description: null,
      createdByUserId: admin,
      treasuryEnabled: true,
      treasuryAccountPublicKey: PUBLIC_KEY,
      treasuryRequiredSigners: 1,
      archived: false,
      createdAt: new Date(),
    });
    const resOk = await appInstance.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/treasury/enable`,
      headers: bearer(admin),
      payload: { publicKey: PUBLIC_KEY },
    });
    // The admin guard permits the request through
    expect(resOk.statusCode).not.toBe(403);
    expect(resOk.statusCode).not.toBe(401);
  });

  it("enforces member access on POST /groups/:id/treasury/deposit", async () => {
    const outsider = newUser(null);
    const resForbidden = await appInstance.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/treasury/deposit`,
      headers: bearer(outsider),
      payload: { amount: "10.0000000", assetCode: "XLM" },
    });
    expect(resForbidden.statusCode).toBe(403);

    const member = newUser("member");
    const resMember = await appInstance.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/treasury/deposit`,
      headers: bearer(member),
      payload: { amount: "10.0000000", assetCode: "XLM" },
    });
    // Passed the guard; may fail downstream on treasury disabled/mocked Horizon
    expect(resMember.statusCode).not.toBe(403);
    expect(resMember.statusCode).not.toBe(401);
  });
});
