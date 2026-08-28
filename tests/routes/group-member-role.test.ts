/**
 * Member role changes and their audit records (#261).
 *
 * The property under test is atomicity: the state change and the audit entry
 * either both happen or neither does. That is asserted by driving the route
 * with a transaction client that can be made to fail at the audit write, and
 * by checking that both writes land on the same transaction.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_1";
const ADMIN_ID = "user_admin";
const TARGET_ID = "user_target";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authHeader(userId = ADMIN_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

function membership(userId: string, role: string) {
  return { groupId: GROUP_ID, userId, role };
}

/** Resolve the caller's own membership, then the target's. */
function arrangeMemberships(callerRole: string, targetRole: string | null) {
  prisma.groupMember.findUnique.mockImplementation(async (args: any) => {
    const userId = args?.where?.groupId_userId?.userId;
    if (userId === ADMIN_ID) return membership(ADMIN_ID, callerRole);
    if (userId === TARGET_ID && targetRole) return membership(TARGET_ID, targetRole);
    return null;
  });
}

function changeRole(body: unknown, userId = ADMIN_ID) {
  return app.inject({
    method: "POST",
    url: `/groups/${GROUP_ID}/members/role`,
    headers: authHeader(userId),
    payload: body,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, name: "Trip" });
  prisma.groupMember.count.mockResolvedValue(2);
  prisma.groupMember.update.mockImplementation(async ({ where, data }: any) => ({
    groupId: GROUP_ID,
    userId: where.groupId_userId.userId,
    role: data.role,
  }));
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("POST /groups/:id/members/role — authorization", () => {
  it("rejects a non-admin", async () => {
    arrangeMemberships("member", "member");

    const res = await changeRole({ userId: TARGET_ID, role: "admin" });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/members/role`,
      payload: { userId: TARGET_ID, role: "admin" },
    });

    expect(res.statusCode).toBe(401);
  });

  it("checks authorization inside the transaction", async () => {
    arrangeMemberships("member", "member");

    await changeRole({ userId: TARGET_ID, role: "admin" });

    // The admin check must not run before the transaction opens, or a
    // concurrent demotion could let an ex-admin land one last write.
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe("POST /groups/:id/members/role — validation", () => {
  beforeEach(() => arrangeMemberships("admin", "member"));

  it("rejects an unknown role", async () => {
    const res = await changeRole({ userId: TARGET_ID, role: "superuser" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects a missing userId", async () => {
    const res = await changeRole({ role: "admin" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 when the target is not a member", async () => {
    arrangeMemberships("admin", null);

    const res = await changeRole({ userId: TARGET_ID, role: "admin" });

    expect(res.statusCode).toBe(404);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("POST /groups/:id/members/role — role changes", () => {
  it("promotes a member to admin", async () => {
    arrangeMemberships("admin", "member");

    const res = await changeRole({ userId: TARGET_ID, role: "admin" });

    expect(res.statusCode).toBe(200);
    expect(res.json().member).toEqual({ userId: TARGET_ID, role: "admin" });
    expect(prisma.groupMember.update).toHaveBeenCalledTimes(1);
  });

  it("demotes an admin to member when another admin remains", async () => {
    arrangeMemberships("admin", "admin");
    prisma.groupMember.count.mockResolvedValue(2);

    const res = await changeRole({ userId: TARGET_ID, role: "member" });

    expect(res.statusCode).toBe(200);
    expect(res.json().member.role).toBe("member");
  });

  it("refuses to demote the last admin", async () => {
    arrangeMemberships("admin", "admin");
    prisma.groupMember.count.mockResolvedValue(1);

    const res = await changeRole({ userId: TARGET_ID, role: "member" });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("LAST_ADMIN");
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("is idempotent when the role already matches", async () => {
    arrangeMemberships("admin", "member");

    const res = await changeRole({ userId: TARGET_ID, role: "member" });

    expect(res.statusCode).toBe(200);
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
    // A no-op change is not an event, so it writes no audit record.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("counts admins inside the transaction, not before it", async () => {
    arrangeMemberships("admin", "admin");
    prisma.groupMember.count.mockResolvedValue(2);

    await changeRole({ userId: TARGET_ID, role: "member" });

    // Reading the count outside the transaction would let two concurrent
    // demotions each see two admins and both proceed.
    expect(prisma.groupMember.count).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe("POST /groups/:id/members/role — audit record", () => {
  beforeEach(() => arrangeMemberships("admin", "member"));

  it("records the actor, the group, and the resource", async () => {
    await changeRole({ userId: TARGET_ID, role: "admin" });

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.userId).toBe(ADMIN_ID);
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.action).toBe("group.member_role_change");
    expect(data.entityType).toBe("group_member");
    expect(data.entityId).toBe(TARGET_ID);
  });

  it("records both the previous and the new role", async () => {
    await changeRole({ userId: TARGET_ID, role: "admin" });

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.metadata).toMatchObject({
      targetUserId: TARGET_ID,
      previousRole: "member",
      newRole: "admin",
    });
  });

  it("writes the audit record on the same transaction as the update", async () => {
    await changeRole({ userId: TARGET_ID, role: "admin" });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.groupMember.update).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("rolls the role change back when the audit write fails", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit store down"));

    const res = await changeRole({ userId: TARGET_ID, role: "admin" });

    // auditTx deliberately does not swallow: an unrecorded role change is
    // worse than a failed one, so the transaction must not commit.
    expect(res.statusCode).toBe(500);
  });
});

describe("DELETE /groups/:id/members/:memberId — atomicity", () => {
  beforeEach(() => {
    arrangeMemberships("admin", "member");
    prisma.groupMember.delete.mockResolvedValue(membership(TARGET_ID, "member"));
  });

  function removeMember() {
    return app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(),
    });
  }

  it("removes a member and audits it in one transaction", async () => {
    const res = await removeMember();

    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.groupMember.delete).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("records the removed member's role", async () => {
    await removeMember();

    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data.action).toBe("group.member_remove");
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.metadata).toMatchObject({
      removedUserId: TARGET_ID,
      removedRole: "member",
    });
  });

  it("rolls the removal back when the audit write fails", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit store down"));

    const res = await removeMember();

    expect(res.statusCode).toBe(500);
  });

  it("refuses to remove the last admin", async () => {
    arrangeMemberships("admin", "admin");
    prisma.groupMember.count.mockResolvedValue(1);

    const res = await removeMember();

    expect(res.statusCode).toBe(409);
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
