/**
 * Group membership and role-based access-control tests.
 *
 * Every group action must check membership, and admin-only actions must check
 * the caller's role. These tests exercise that contract at the HTTP layer
 * across the four authorization scenarios the Drips Wave issue calls out —
 * owner (the creating admin), a plain admin, a regular member, and a
 * non-member / stranger — and verifies that access is allowed for
 * admins/members on the actions that require it and denied for users without
 * it. The underlying `requireMembership`/`requireAdmin` helpers are unit
 * tested in tests/access.test.ts; this file proves the routes wire them up.
 *
 * Membership and role are always read from the database row (via the mocked
 * Prisma client), never from anything the caller sends.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const VALID_PUBLIC_KEY = Keypair.random().publicKey();

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 1),
    upsert: vi.fn(),
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
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;

const groupRow = {
  id: "group_1",
  name: "Trip",
  description: null,
  createdByUserId: "owner_1",
  treasuryEnabled: false,
  treasuryAccountPublicKey: null,
  treasuryRequiredSigners: null,
  archived: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const ownerId = "owner_1";
const adminId = "admin_1";
const memberId = "member_1";
const strangerId = "stranger_1";

function authHeader(userId: string) {
  const token = signToken({
    id: userId,
    stellarPublicKey: VALID_PUBLIC_KEY,
  });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  // Every membership/role lookup is answered from this map, keyed by user id,
  // which is exactly where the real database reads `member.role` from.
  const membership = new Map<string, { role: string } | null>([
    [ownerId, { role: "admin" }],
    [adminId, { role: "admin" }],
    [memberId, { role: "member" }],
    // strangers / non-members are absent from the map
  ]);
  prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
    const userId = where?.groupId_userId?.userId;
    return membership.has(userId) ? membership.get(userId) : null;
  });

  prisma.group.findUnique.mockResolvedValue({ ...groupRow });
});

describe("GET /groups/:id — membership access", () => {
  it("allows the group owner (admin)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1",
      headers: authHeader(ownerId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().group.id).toBe("group_1");
    expect(res.json().yourRole).toBe("admin");
  });

  it("allows a regular admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1",
      headers: authHeader(adminId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().yourRole).toBe("admin");
  });

  it("allows a member", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1",
      headers: authHeader(memberId),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().yourRole).toBe("member");
  });

  it("denies a non-member with 403 (group exists)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1",
      headers: authHeader(strangerId),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("responds 404 (not 403) when the group does not exist", async () => {
    prisma.group.findUnique.mockResolvedValue(null);
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1",
      headers: authHeader(strangerId),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("NOT_FOUND");
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/groups/group_1" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /groups/:id/invite — admin-only", () => {
  async function invite(userId: string) {
    return app.inject({
      method: "POST",
      url: "/groups/group_1/invite",
      headers: authHeader(userId),
      payload: { publicKey: VALID_PUBLIC_KEY },
    });
  }

  it("allows the owner to invite by public key", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.invitation.findFirst.mockResolvedValue(null);
    prisma.invitation.create.mockResolvedValue({
      id: "inv_1",
      groupId: "group_1",
      inviteePublicKey: VALID_PUBLIC_KEY,
      status: "PENDING",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await invite(ownerId);
    expect(res.statusCode).toBe(201);
    expect(res.json().invitation.inviteePublicKey).toBe(VALID_PUBLIC_KEY);
    expect(prisma.invitation.create).toHaveBeenCalledTimes(1);
  });

  it("allows another admin to invite", async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.invitation.findFirst.mockResolvedValue(null);
    prisma.invitation.create.mockResolvedValue({
      id: "inv_2",
      groupId: "group_1",
      inviteePublicKey: VALID_PUBLIC_KEY,
      status: "PENDING",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await invite(adminId);
    expect(res.statusCode).toBe(201);
  });

  it("denies a member (not an admin) with 403", async () => {
    const res = await invite(memberId);
    expect(res.statusCode).toBe(403);
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });

  it("denies a non-member with 403", async () => {
    const res = await invite(strangerId);
    expect(res.statusCode).toBe(403);
    expect(prisma.invitation.create).not.toHaveBeenCalled();
  });

  it("responds 404 when the group does not exist", async () => {
    prisma.group.findUnique.mockResolvedValue(null);
    const res = await invite(strangerId);
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /groups/:id/members/role — admin-only", () => {
  async function changeRole(userId: string) {
    return app.inject({
      method: "POST",
      url: "/groups/group_1/members/role",
      headers: authHeader(userId),
      payload: { userId: memberId, role: "admin" },
    });
  }

  it("allows an admin to promote a member to admin", async () => {
    prisma.groupMember.update.mockResolvedValue({ userId: memberId, role: "admin" });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await changeRole(adminId);
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toEqual({ userId: memberId, role: "admin" });
    // The admin check read the caller's own row before querying the target.
    expect(prisma.groupMember.findUnique).toHaveBeenCalled();
  });

  it("denies a member with 403", async () => {
    const res = await changeRole(memberId);
    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
  });

  it("denies a non-member with 403", async () => {
    const res = await changeRole(strangerId);
    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /groups/:id/members/:memberId — admin-only", () => {
  async function remove(userId: string) {
    return app.inject({
      method: "DELETE",
      url: "/groups/group_1/members/member_2",
      headers: authHeader(userId),
    });
  }

  it("allows an admin to remove another member", async () => {
    // The target "member_2" exists and is a plain member (never an admin, so
    // the last-admin guard is skipped). The caller's admin row is what the
    // requireAdmin check reads.
    prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
      const userId = where?.groupId_userId?.userId;
      if (userId === "member_2") return { role: "member" };
      return { role: "admin" };
    });
    prisma.groupMember.delete.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});

    const res = await remove(adminId);
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(prisma.groupMember.delete).toHaveBeenCalledTimes(1);
  });

  it("denies a member with 403", async () => {
    const res = await remove(memberId);
    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("denies a non-member with 403", async () => {
    const res = await remove(strangerId);
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /groups/:id/archive — admin-only", () => {
  async function archive(userId: string) {
    return app.inject({
      method: "POST",
      url: "/groups/group_1/archive",
      headers: authHeader(userId),
    });
  }

  it("allows an admin to archive the group", async () => {
    prisma.group.update.mockResolvedValue({ ...groupRow, archived: true });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await archive(adminId);
    expect(res.statusCode).toBe(200);
    expect(res.json().group.archived).toBe(true);
  });

  it("allows the owner to archive the group", async () => {
    prisma.group.update.mockResolvedValue({ ...groupRow, archived: true });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await archive(ownerId);
    expect(res.statusCode).toBe(200);
    expect(res.json().group.archived).toBe(true);
  });

  it("denies a member with 403", async () => {
    const res = await archive(memberId);
    expect(res.statusCode).toBe(403);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("denies a non-member with 403", async () => {
    const res = await archive(strangerId);
    expect(res.statusCode).toBe(403);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });
});