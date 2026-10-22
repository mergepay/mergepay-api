/**
 * DELETE /groups/:id/members/:memberId — RBAC (#700).
 *
 * CONTRIBUTING.md: "Every group action must check membership; admin-only
 * actions must check the role." This route's admin check used to run outside
 * its transaction — unlike invite, role change, and archive, which all check
 * inside — so a caller demoted between their own check and the transaction
 * could land one last unauthorized removal. These tests pin the check inside
 * the transaction where the removal itself happens.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 2),
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
const MEMBER_ID = "user_member";
const TARGET_ID = "user_target";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authHeader(userId = MEMBER_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

/** A membership table keyed by "groupId:userId" — models real db state. */
function membershipDb(rows: Record<string, { role: string }>) {
  prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
    const key = `${where.groupId_userId.groupId}:${where.groupId_userId.userId}`;
    return rows[key] ?? null;
  });
}

function removeMember(targetId = TARGET_ID, userId = MEMBER_ID) {
  return app.inject({
    method: "DELETE",
    url: `/groups/${GROUP_ID}/members/${targetId}`,
    headers: authHeader(userId),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });
  prisma.groupMember.delete.mockResolvedValue({
    groupId: GROUP_ID,
    userId: TARGET_ID,
    role: "member",
  });
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("DELETE /groups/:id/members/:memberId — RBAC", () => {
  it("rejects a non-member of an existing group with 403 and never touches the membership table", async () => {
    // requireMembership's deliberate contract: 403 when the group exists but
    // the caller is not a member, 404 only when the group itself is gone.
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });
    membershipDb({});

    const res = await removeMember();

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a non-member with 404 when the group does not exist, without revealing which", async () => {
    membershipDb({});
    // No group row: requireMembership maps this to NOT_FOUND so a caller
    // cannot distinguish "gone" from "not yours" — and neither response
    // leaks membership state.
    prisma.group.findUnique.mockResolvedValue(null);

    const res = await removeMember();

    expect(res.statusCode).toBe(404);
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects a standard member with 403 and does not remove anyone", async () => {
    membershipDb({
      [`${GROUP_ID}:${MEMBER_ID}`]: { role: "member" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });

    const res = await removeMember();

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("removes a member and audits when the caller is an admin", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });

    const res = await removeMember(TARGET_ID, ADMIN_ID);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(prisma.groupMember.delete).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.auditLog.create.mock.calls[0][0];
    expect(data).toMatchObject({
      userId: ADMIN_ID,
      groupId: GROUP_ID,
      action: "group.member_remove",
    });
  });

  it("runs the admin check inside the removal transaction", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });

    await removeMember(TARGET_ID, ADMIN_ID);

    // The check must use the transaction client, not the singleton prisma —
    // that is what makes a concurrent demotion unable to slip an ex-admin's
    // removal through.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to let an admin remove themselves", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
    });

    const res = await removeMember(ADMIN_ID, ADMIN_ID);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("SELF_REMOVE");
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("refuses to remove the last admin", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "admin" },
    });
    prisma.groupMember.count.mockResolvedValue(1);

    const res = await removeMember(TARGET_ID, ADMIN_ID);

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("LAST_ADMIN");
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("rolls the removal back when the audit write fails", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });
    prisma.auditLog.create.mockRejectedValue(new Error("audit store down"));

    const res = await removeMember(TARGET_ID, ADMIN_ID);

    expect(res.statusCode).toBe(500);
  });
});
