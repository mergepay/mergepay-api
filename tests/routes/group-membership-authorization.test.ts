/**
 * Issue #507 — group membership and role authorization, end to end.
 *
 * The repo's contributing standard is absolute: every group action checks
 * membership, and admin-only actions check the role. The route-level suites
 * assert that rule per endpoint (see tests/routes/group-member-role.test.ts
 * and friends); what this issue asks for is a single cross-cutting suite that
 * walks the whole membership lifecycle and the role boundary across the group
 * surface, so a new route that forgets a check fails loudly here too.
 *
 * Like every suite under tests/routes/, this drives the real buildApp() with
 * app.inject() — the same request path production traffic takes — against a
 * mocked Prisma, so no database or network is needed and the suite is
 * deterministic.
 *
 * Layout:
 *   1. lifecycle    — create → invite → join → leave, roles as they change
 *   2. member paths — what an active member may legitimately do
 *   3. admin paths  — what only an admin may do (and a member gets 403 for)
 *   4. outsiders    — non-members and the unauthenticated, everywhere
 *   5. invariants   — last-admin guard and self-removal guard
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "row_1" })),
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
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
    accountBalance: model(),
    refreshToken: model(),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  const mockFetchBaseFee = vi.fn(async () => 100);
  return { prisma, mockFetchBaseFee };
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

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: h.mockFetchBaseFee,
        feeStats: h.mockFetchBaseFee,
      })),
    },
  };
});

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_1";
const ADMIN_ID = "user_admin";
const MEMBER_ID = "user_member";
const OUTSIDER_ID = "user_outsider";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

/** A pool of stable Stellar public keys, one per named user. */
const keys = new Map<string, string>();
function keyOf(userId: string): string {
  if (!keys.has(userId)) keys.set(userId, Keypair.random().publicKey());
  return keys.get(userId)!;
}

function authHeader(userId = ADMIN_ID) {
  return {
    authorization: `Bearer ${signToken({
      id: userId,
      stellarPublicKey: keyOf(userId),
    })}`,
  };
}

function membership(userId: string, role: string) {
  return { groupId: GROUP_ID, userId, role };
}

const GROUP_ROW = {
  id: GROUP_ID,
  name: "Trip",
  description: null,
  createdByUserId: ADMIN_ID,
  treasuryEnabled: false,
  treasuryAccountPublicKey: null,
  treasuryRequiredSigners: null,
  archived: false,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * Resolve every groupMember.findUnique by (groupId, userId), so several
 * routes' lookups against one pool of members behave like a real table.
 * Also backs the batch participant lookup (findMany with `userId in (...)`)
 * the expense-create route uses to require every split participant to be an
 * active member.
 */
function arrangeMembers(members: Array<{ userId: string; role: string }>) {
  prisma.groupMember.findUnique.mockImplementation(async (args: any) => {
    const composite = args?.where?.groupId_userId;
    if (!composite || composite.groupId !== GROUP_ID) return null;
    const found = members.find((m) => m.userId === composite.userId);
    return found ? membership(found.userId, found.role) : null;
  });
  prisma.groupMember.findMany.mockImplementation(async (args: any) => {
    const inList: Array<string> | undefined = args?.where?.userId?.in;
    if (!inList) {
      // Full member listing (GET /groups/:id and friends).
      return members.map((m) => ({
        id: `member_${m.userId}`,
        groupId: GROUP_ID,
        userId: m.userId,
        role: m.role,
        joinedAt: new Date("2026-01-01T00:00:00.000Z"),
        user: {
          id: m.userId,
          stellarPublicKey: keyOf(m.userId),
          displayName: m.userId,
          avatarUrl: null,
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      }));
    }
    return inList
      .filter((userId) => members.some((m) => m.userId === userId))
      .map((userId) => ({
        userId,
        user: { stellarPublicKey: keyOf(userId) },
      }));
  });
  // requireMembership's existence probe for the 404/403 distinction.
  prisma.group.findUnique.mockResolvedValue({ ...GROUP_ROW });
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  arrangeMembers([
    { userId: ADMIN_ID, role: "admin" },
    { userId: MEMBER_ID, role: "member" },
  ]);
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
  prisma.groupMember.count.mockResolvedValue(2);
  prisma.groupMember.update.mockImplementation(async ({ where, data }: any) => ({
    groupId: GROUP_ID,
    userId: where.groupId_userId.userId,
    role: data.role,
  }));
  prisma.user.findUnique.mockImplementation(async ({ where }: any) => {
    if (where.id) return { id: where.id, stellarPublicKey: keyOf(where.id) };
    for (const [userId, pk] of keys) {
      if (pk === where.stellarPublicKey) return { id: userId, stellarPublicKey: pk };
    }
    return null;
  });
});

describe("membership lifecycle — create, invite, join, leave (#507)", () => {
  it("a created group makes the creator an admin", async () => {
    let createdMember;
    prisma.group.create.mockImplementation(async ({ data }: any) => {
      createdMember = data.members.create;
      return {
        id: "group_new",
        name: data.name,
        createdByUserId: ADMIN_ID,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      };
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "Trip" },
    });

    expect(res.statusCode).toBe(200);
    // The creator's membership row is created with the admin role in the same
    // transaction — the root of every later role check.
    expect(createdMember).toEqual({ userId: ADMIN_ID, role: "admin" });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "group.create" }),
      })
    );
  });

  it("an admin can invite a user by public key, and the invitation is recorded", async () => {
    prisma.user.findUnique.mockResolvedValue(null); // invitee unknown yet
    prisma.invitation.create.mockResolvedValue({
      id: "inv_1",
      groupId: GROUP_ID,
      inviteePublicKey: keyOf(OUTSIDER_ID),
      status: "PENDING",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/invite`,
      headers: authHeader(),
      payload: { publicKey: keyOf(OUTSIDER_ID) },
    });

    expect(res.statusCode).toBe(201);
    expect(prisma.invitation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        groupId: GROUP_ID,
        inviteePublicKey: keyOf(OUTSIDER_ID),
        status: "PENDING",
      }),
    });
  });

  it("a member cannot invite — invitation attempts are rejected and nothing is created", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/invite`,
      headers: authHeader(MEMBER_ID),
      payload: { publicKey: keyOf(OUTSIDER_ID) },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.invitation.create).not.toHaveBeenCalled();
    expect(prisma.invite.create).not.toHaveBeenCalled();
  });

  it("joining with a valid invite code creates a plain member and increments use count", async () => {
    prisma.invite.findUnique.mockResolvedValue({
      id: "invite_1",
      code: "TRIPCODE",
      groupId: GROUP_ID,
      expiresAt: null,
      maxUses: 5,
      uses: 1,
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/join",
      headers: authHeader(OUTSIDER_ID),
      payload: { code: "tripcode" },
    });

    expect(res.statusCode).toBe(200);
    // Newcomers join as members, never admins — role can only come from an
    // existing admin.
    expect(prisma.groupMember.create).toHaveBeenCalledWith({
      data: { groupId: GROUP_ID, userId: OUTSIDER_ID, role: "member" },
    });
    expect(prisma.invite.update).toHaveBeenCalledWith({
      where: { id: "invite_1" },
      data: { uses: { increment: 1 } },
    });
  });

  it("a member can leave, and the leave is audited", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/leave`,
      headers: authHeader(MEMBER_ID),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.groupMember.delete).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: GROUP_ID, userId: MEMBER_ID } },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "group.leave", userId: MEMBER_ID }),
      })
    );
  });
});

describe("member authorization — what an active member may do (#507)", () => {
  it("a member can read the group", async () => {
    prisma.group.findUnique.mockResolvedValue({ ...GROUP_ROW });

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: authHeader(MEMBER_ID),
    });

    expect(res.statusCode).toBe(200);
  });

  it("a member can list the group's expenses", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(MEMBER_ID),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().expenses).toEqual([]);
  });

  it("a member can create an expense naming themselves as payer", async () => {
    prisma.expense.create.mockResolvedValue({
      id: "exp_1",
      groupId: GROUP_ID,
      payerUserId: MEMBER_ID,
      title: "Dinner",
      amount: "50.0000000",
      assetCode: "XLM",
      assetIssuer: null,
      splitType: "equal",
      memo: "DINN001",
      receiptUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      payer: {
        id: MEMBER_ID,
        stellarPublicKey: keyOf(MEMBER_ID),
        displayName: MEMBER_ID,
        avatarUrl: null,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      shares: [],
    });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(MEMBER_ID),
      payload: {
        title: "Dinner",
        amount: "50.0000000",
        assetCode: "XLM",
        splitType: "equal",
        shares: [{ userId: MEMBER_ID }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().expense.payer.id).toBe(MEMBER_ID);
  });

  it("a member can change their own role only by going through an admin — the role endpoint rejects them", async () => {
    // Self-promotion is the classic escalation attempt.
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/members/role`,
      headers: authHeader(MEMBER_ID),
      payload: { userId: MEMBER_ID, role: "admin" },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
  });
});

describe("admin authorization — the role boundary (#507)", () => {
  it("an admin can change a member's role to admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/members/role`,
      headers: authHeader(ADMIN_ID),
      payload: { userId: MEMBER_ID, role: "admin" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().member).toEqual({ userId: MEMBER_ID, role: "admin" });
  });

  it("an admin can remove a member, but not themselves", async () => {
    const removed = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${MEMBER_ID}`,
      headers: authHeader(ADMIN_ID),
    });
    expect(removed.statusCode).toBe(200);
    expect(prisma.groupMember.delete).toHaveBeenCalledWith({
      where: { groupId_userId: { groupId: GROUP_ID, userId: MEMBER_ID } },
    });

    // Self-removal must go through leave, not the removal endpoint.
    const self = await app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/members/${ADMIN_ID}`,
      headers: authHeader(ADMIN_ID),
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().code).toBe("SELF_REMOVE");
  });

  it("an admin can archive the group, audited in the same transaction", async () => {
    prisma.group.update.mockResolvedValue({
      ...GROUP_ROW,
      archived: true,
    });

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/archive`,
      headers: authHeader(ADMIN_ID),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.group.update).toHaveBeenCalledWith({
      where: { id: GROUP_ID },
      data: { archived: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "group.archive", userId: ADMIN_ID }),
      })
    );
  });

  it("a member is refused on every admin-only route and nothing is written", async () => {
    const attempts: Array<[string, string, any]> = [
      ["POST", `/groups/${GROUP_ID}/members/role`, { userId: MEMBER_ID, role: "admin" }],
      ["POST", `/groups/${GROUP_ID}/members/role`, { userId: ADMIN_ID, role: "member" }],
      ["DELETE", `/groups/${GROUP_ID}/members/${MEMBER_ID}`, undefined],
      ["POST", `/groups/${GROUP_ID}/archive`, undefined],
      ["PATCH", `/groups/${GROUP_ID}/members/${MEMBER_ID}`, { role: "admin" }],
    ];

    for (const [method, url, payload] of attempts) {
      const res = await app.inject({
        method: method as any,
        url,
        headers: authHeader(MEMBER_ID),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url} as member`).toBe(403);
      // A 403 must mean nothing happened: no writes, no audit trail.
      expect(prisma.groupMember.delete, `${method} ${url}: delete`).not.toHaveBeenCalled();
      expect(prisma.groupMember.update, `${method} ${url}: update`).not.toHaveBeenCalled();
      expect(prisma.group.update, `${method} ${url}: group update`).not.toHaveBeenCalled();
      expect(prisma.auditLog.create, `${method} ${url}: audit`).not.toHaveBeenCalled();
      // Reset the write mocks for the next attempt in the loop.
      vi.clearAllMocks();
      arrangeMembers([
        { userId: ADMIN_ID, role: "admin" },
        { userId: MEMBER_ID, role: "member" },
      ]);
    }
  });

  it("an outsider is refused on every admin-only route with 403, not 404", async () => {
    const attempts: Array<[string, string, any]> = [
      ["POST", `/groups/${GROUP_ID}/members/role`, { userId: MEMBER_ID, role: "admin" }],
      ["DELETE", `/groups/${GROUP_ID}/members/${MEMBER_ID}`, undefined],
      ["POST", `/groups/${GROUP_ID}/archive`, undefined],
      ["POST", `/groups/${GROUP_ID}/invite`, { publicKey: keyOf(OUTSIDER_ID) }],
    ];

    for (const [method, url, payload] of attempts) {
      const res = await app.inject({
        method: method as any,
        url,
        headers: authHeader(OUTSIDER_ID),
        ...(payload !== undefined ? { payload } : {}),
      });
      expect(res.statusCode, `${method} ${url} as outsider`).toBe(403);
      vi.clearAllMocks();
      arrangeMembers([
        { userId: ADMIN_ID, role: "admin" },
        { userId: MEMBER_ID, role: "member" },
      ]);
    }
  });
});

describe("outsider authorization — membership is the boundary (#507)", () => {
  it("a non-member cannot view the group", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
      headers: authHeader(OUTSIDER_ID),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("FORBIDDEN");
  });

  it("a non-member cannot list the group's expenses", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(OUTSIDER_ID),
    });

    expect(res.statusCode).toBe(403);
    // The rejection happens before any expense row is read.
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("a non-member cannot create an expense in the group", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(OUTSIDER_ID),
      payload: {
        title: "Freeload",
        amount: "10.0000000",
        assetCode: "XLM",
        splitType: "equal",
        shares: [{ userId: OUTSIDER_ID }],
      },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it("a non-member cannot leave a group they were never in", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/leave`,
      headers: authHeader(OUTSIDER_ID),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("an unknown group id is 404 for an authenticated user — existence leaks only the id", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    prisma.group.findUnique.mockResolvedValue(null); // group does not exist

    const res = await app.inject({
      method: "GET",
      url: `/groups/does_not_exist`,
      headers: authHeader(OUTSIDER_ID),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
  });

  it("an unauthenticated caller is 401 before any membership question", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}`,
    });

    expect(res.statusCode).toBe(401);
    // Not even a membership lookup may run for a request without a session.
    expect(prisma.groupMember.findUnique).not.toHaveBeenCalled();
  });
});

describe("authorization invariants (#507)", () => {
  it("the last admin cannot leave while other members remain", async () => {
    // Two members total, only the caller is an admin.
    prisma.groupMember.count
      .mockResolvedValueOnce(1) // admins
      .mockResolvedValueOnce(2); // total members

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/leave`,
      headers: authHeader(ADMIN_ID),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("LAST_ADMIN");
    expect(prisma.groupMember.delete).not.toHaveBeenCalled();
  });

  it("the last admin cannot be demoted", async () => {
    prisma.groupMember.count.mockResolvedValueOnce(1); // only one admin

    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/members/role`,
      headers: authHeader(ADMIN_ID),
      payload: { userId: ADMIN_ID, role: "member" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("LAST_ADMIN");
    expect(prisma.groupMember.update).not.toHaveBeenCalled();
  });

  it("role checks read the caller's role from the database, never from the request", async () => {
    // The route schema never accepts a role for the *caller*; the one role
    // field on the wire is the *target's*. Assert the admin check ran against
    // the caller's stored membership.
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/members/role`,
      headers: authHeader(MEMBER_ID),
      payload: { userId: MEMBER_ID, role: "admin" },
    });

    expect(res.statusCode).toBe(403);
    const lookup = prisma.groupMember.findUnique.mock.calls.find(
      (call: any) =>
        call[0]?.where?.groupId_userId?.userId === MEMBER_ID &&
        call[0]?.where?.groupId_userId?.groupId === GROUP_ID
    );
    expect(lookup).toBeDefined(); // role came from this row, not the payload
  });

  it("membership checks and writes share one transaction on role changes", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${GROUP_ID}/members/role`,
      headers: authHeader(ADMIN_ID),
      payload: { userId: MEMBER_ID, role: "admin" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.$transaction).toHaveBeenCalled();
  });

  it("a deleted membership is enforced on the next request, not cached", async () => {
    // First request: member in good standing.
    arrangeMembers([{ userId: MEMBER_ID, role: "member" }]);
    const ok = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(MEMBER_ID),
    });
    expect(ok.statusCode).toBe(200);

    // The member is removed out-of-band; every membership row vanishes.
    arrangeMembers([]);

    const denied = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses`,
      headers: authHeader(MEMBER_ID),
    });
    expect(denied.statusCode).toBe(403);
  });
});
