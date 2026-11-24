/**
 * Role-based authorization helper for group management and member removal (#1137).
 *
 * Verifies that:
 *   - `requireGroupManagementGuard` exists and enforces admin + active-group
 *     on DELETE /groups/:id/members/:memberId and PATCH /groups/:id/members/:memberId.
 *   - `requireMemberRemovalGuard` and `requireRoleModificationGuard` are
 *     named aliases that behave identically.
 *   - Unauthenticated callers receive 401.
 *   - Non-members and regular members receive 403 Forbidden.
 *   - Admins of active groups are allowed through.
 *   - Admins of archived groups are blocked (active: true enforcement).
 *
 * Uses the real buildApp() against a mocked Prisma so the entire Fastify
 * pipeline runs — authentication, preHandler guard, route handler — without
 * needing a database or network.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "audit_1" })),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findUniqueOrThrow: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 2),
  });

  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
    accountBalance: model(),
    refreshToken: model(),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(async () => []),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import {
  requireGroupManagementGuard,
  requireMemberRemovalGuard,
  requireRoleModificationGuard,
} from "../../src/middleware/group-guard";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_mgmt_1";
const ADMIN_ID = "user_admin";
const MEMBER_ID = "user_member";
const TARGET_ID = "user_target";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authHeader(userId = MEMBER_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

/** Seed the in-memory membership table. */
function membershipDb(rows: Record<string, { role: string; group?: { archivedAt?: Date | null } }>) {
  prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
    const key = `${where.groupId_userId.groupId}:${where.groupId_userId.userId}`;
    const row = rows[key];
    if (!row) return null;
    return {
      userId: where.groupId_userId.userId,
      groupId: where.groupId_userId.groupId,
      role: row.role,
      group: row.group ?? { archivedAt: null },
    };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, archived: false, archivedAt: null });
  prisma.groupMember.delete.mockResolvedValue({ id: "deleted" });
  prisma.groupMember.update.mockResolvedValue({
    id: `${GROUP_ID}_${TARGET_ID}`,
    userId: TARGET_ID,
    groupId: GROUP_ID,
    role: "admin",
    joinedAt: new Date("2024-01-01"),
    user: {
      id: TARGET_ID,
      stellarPublicKey: PUBLIC_KEY,
      displayName: "Target User",
      avatarUrl: null,
      createdAt: new Date("2024-01-01"),
    },
  });
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

// ── Named exports ─────────────────────────────────────────────────────────────

describe("requireGroupManagementGuard — named exports (#1137)", () => {
  it("exports requireGroupManagementGuard as a function", () => {
    expect(typeof requireGroupManagementGuard).toBe("function");
  });

  it("requireMemberRemovalGuard is the same function as requireGroupManagementGuard", () => {
    expect(requireMemberRemovalGuard).toBe(requireGroupManagementGuard);
  });

  it("requireRoleModificationGuard is the same function as requireGroupManagementGuard", () => {
    expect(requireRoleModificationGuard).toBe(requireGroupManagementGuard);
  });

  it("requireGroupManagementGuard() returns a preHandler async hook", () => {
    const guard = requireGroupManagementGuard();
    expect(typeof guard).toBe("function");
    expect(guard.constructor.name).toBe("AsyncFunction");
  });
});

// ── DELETE /groups/:id/members/:memberId ─────────────────────────────────────

describe("DELETE /groups/:id/members/:memberId — admin guard (#1137)", () => {
  it("returns 401 when no auth token is provided", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 Forbidden when the caller is not a group member", async () => {
    membershipDb({});

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(MEMBER_ID),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when the caller is a regular member (not admin)", async () => {
    membershipDb({
      [`${GROUP_ID}:${MEMBER_ID}`]: { role: "member" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(MEMBER_ID),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("allows an admin to remove a member (200 OK)", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });
    // removeGroupMember reads the target membership inside the transaction
    prisma.$transaction.mockImplementationOnce(async (fn: any) => fn(prisma));
    prisma.groupMember.count.mockResolvedValue(2);

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(ADMIN_ID),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it("returns 403 for archived group even when caller is admin", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
    });
    // assertGroupActive checks group.archived, not archivedAt — override default mock
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, archived: true });

    const res = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(ADMIN_ID),
    });

    // active: true in the guard blocks archived groups
    expect(res.statusCode).toBe(403);
  });
});

// ── PATCH /groups/:id/members/:memberId — role modification ───────────────────

describe("PATCH /groups/:id/members/:memberId — role modification admin guard (#1137)", () => {
  it("returns 401 when no auth token is provided", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      payload: { role: "admin" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 Forbidden when caller is a regular member", async () => {
    membershipDb({
      [`${GROUP_ID}:${MEMBER_ID}`]: { role: "member" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(MEMBER_ID),
      payload: { role: "admin" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("returns 403 when caller is not a member at all", async () => {
    membershipDb({});

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(MEMBER_ID),
      payload: { role: "admin" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("allows an admin to change a member's role (200 OK)", async () => {
    membershipDb({
      [`${GROUP_ID}:${ADMIN_ID}`]: { role: "admin" },
      [`${GROUP_ID}:${TARGET_ID}`]: { role: "member" },
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/groups/${GROUP_ID}/members/${TARGET_ID}`,
      headers: authHeader(ADMIN_ID),
      payload: { role: "admin" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("member");
  });
});
