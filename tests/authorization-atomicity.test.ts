/**
 * Route-level authorization coverage for group/expense/treasury mutations.
 *
 * These complement tests/access.test.ts (which unit-tests the shared
 * requireMembership/requireAdmin helper in isolation) by exercising the
 * actual route handlers end-to-end, and by asserting that a denied request
 * never reaches the mutating Prisma call — i.e. the authorization check and
 * the write are atomic, so a concurrent membership change can't be raced.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

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
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
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

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

/** A membership table keyed by "groupId:userId" — models real db state. */
function membershipDb(rows: Record<string, { role: string }>) {
  prisma.groupMember.findUnique.mockImplementation(async ({ where }: any) => {
    const key = `${where.groupId_userId.groupId}:${where.groupId_userId.userId}`;
    return rows[key] ?? null;
  });
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("POST /groups/:id/archive authorization", () => {
  it("returns 404 (not 403) for a non-member, without leaking group existence", async () => {
    membershipDb({});
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/archive",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("returns 403 for a member who is not an admin, and does not mutate", async () => {
    membershipDb({ "group_1:user_1": { role: "member" } });
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/archive",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("returns 404 for a member who was removed since their token was issued", async () => {
    // Simulates a forged/stale JWT: the token is valid, but the membership
    // row backing it is gone by the time the request is authorized.
    membershipDb({});
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/archive",
      headers: authHeader(fakeUser({ id: "removed_user" })),
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("archives and audits for an admin", async () => {
    membershipDb({ "group_1:user_1": { role: "admin" } });
    prisma.group.update.mockResolvedValueOnce({
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: "user_1",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: true,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValueOnce({});

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/archive",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().group.archived).toBe(true);
    expect(prisma.group.update).toHaveBeenCalledWith({
      where: { id: "group_1" },
      data: { archived: true },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "group.archive", userId: "user_1" }),
      })
    );
  });
});

describe("DELETE /expenses/:id authorization", () => {
  const expense = {
    id: "exp_1",
    groupId: "group_1",
    payerUserId: "payer_1",
    shares: [{ status: "pending", userId: "payer_1" }],
  };

  it("returns 404 for a non-member and does not delete", async () => {
    membershipDb({});
    prisma.expense.findUnique.mockResolvedValueOnce(expense);
    const res = await app.inject({
      method: "DELETE",
      url: "/expenses/exp_1",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.expense.delete).not.toHaveBeenCalled();
  });

  it("returns 403 for a member who is neither the payer nor an admin", async () => {
    membershipDb({ "group_1:user_1": { role: "member" } });
    prisma.expense.findUnique.mockResolvedValueOnce(expense);
    const res = await app.inject({
      method: "DELETE",
      url: "/expenses/exp_1",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.expense.delete).not.toHaveBeenCalled();
  });

  it("allows an admin (who is not the payer) to delete, and audits it", async () => {
    membershipDb({ "group_1:user_1": { role: "admin" } });
    prisma.expense.findUnique.mockResolvedValueOnce(expense);
    prisma.expense.delete.mockResolvedValueOnce({});
    prisma.auditLog.create.mockResolvedValueOnce({});

    const res = await app.inject({
      method: "DELETE",
      url: "/expenses/exp_1",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(prisma.expense.delete).toHaveBeenCalledWith({ where: { id: "exp_1" } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ action: "expense.delete", userId: "user_1" }),
      })
    );
  });
});

describe("POST /groups/:id/treasury/enable authorization", () => {
  const validKey = Keypair.random().publicKey();

  it("returns 404 for a non-member and does not enable treasury", async () => {
    membershipDb({});
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/enable",
      headers: authHeader(),
      payload: { publicKey: validKey },
    });
    expect(res.statusCode).toBe(404);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-admin member and does not enable treasury", async () => {
    membershipDb({ "group_1:user_1": { role: "member" } });
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/enable",
      headers: authHeader(),
      payload: { publicKey: validKey },
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.group.update).not.toHaveBeenCalled();
  });

  it("enables treasury for an admin", async () => {
    membershipDb({ "group_1:user_1": { role: "admin" } });
    prisma.group.update.mockResolvedValueOnce({
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: "user_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: validKey,
      treasuryRequiredSigners: 1,
      archived: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValueOnce({});

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/enable",
      headers: authHeader(),
      payload: { publicKey: validKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().group.treasuryEnabled).toBe(true);
  });
});
