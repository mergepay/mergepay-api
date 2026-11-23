import { describe, it, expect, beforeEach, vi } from "vitest";

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
import { encodeCursor } from "../src/lib/pagination";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

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

function fakeEvent(over: Partial<any> = {}) {
  return {
    id: "audit_1",
    userId: "user_1",
    groupId: "group_1",
    action: "expense.create",
    entityType: "expense",
    entityId: "expense_1",
    metadata: { amount: "10.0000000" },
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    user: fakeUser(),
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("GET /groups/:id/audit-log", () => {
  it("returns 403 for a non-admin member", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "member",
    });

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("returns the repository's standard authorization error for a non-member", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns events with a redacted metadata payload for an admin", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([
      fakeEvent({ metadata: { amount: "10", signedXdr: "AAAA...", token: "secret-token" } }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({
      id: "audit_1",
      action: "expense.create",
      entityType: "expense",
      entityId: "expense_1",
      actorUserId: "user_1",
      actorDisplayName: "Tester",
    });
    expect(body.events[0].metadata).toEqual({ amount: "10" });
    expect(body.meta).toEqual({ nextCursor: null, hasMore: false, limit: 50, order: "desc" });
  });

  it("requests one extra row to compute nextCursor and returns it when there are more pages", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([
      fakeEvent({ id: "a1" }),
      fakeEvent({ id: "a2" }),
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log?limit=1",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].id).toBe("a1");
    expect(body.meta.nextCursor).toBe(
      encodeCursor(new Date("2026-02-01T00:00:00.000Z"), "a1")
    );
    expect(body.meta).toMatchObject({ hasMore: true, limit: 1, order: "desc" });

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 2,
        where: expect.objectContaining({ groupId: "group_1" }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      })
    );
  });

  it("applies the shared cursor filter and scopes by group", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([]);

    const createdAt = new Date("2026-02-01T00:00:00.000Z");
    const cursor = encodeCursor(createdAt, "a1");
    const res = await app.inject({
      method: "GET",
      url: `/groups/group_1/audit-log?cursor=${cursor}&action=expense.create&actorUserId=user_1`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          groupId: "group_1",
          action: "expense.create",
          userId: "user_1",
          OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: "a1" } }],
        }),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 51,
      })
    );
    expect(prisma.auditLog.findMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ cursor: expect.anything(), skip: 1 })
    );
  });

  it("returns 400 for an action outside the audit action vocabulary", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log?action=not.a.real.action",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("accepts an action from the audit action vocabulary", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log?action=treasury.proposal.created",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          groupId: "group_1",
          action: "treasury.proposal.created",
        }),
      })
    );
  });

  it("pages through more entries than the limit without overlap", async () => {
    prisma.groupMember.findUnique
      .mockResolvedValueOnce({ groupId: "group_1", userId: "user_1", role: "admin" })
      .mockResolvedValueOnce({ groupId: "group_1", userId: "user_1", role: "admin" });

    const rows = ["a1", "a2", "a3", "a4", "a5"].map((id, index) =>
      fakeEvent({ id, createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, 5 - index)) })
    );
    prisma.auditLog.findMany
      .mockImplementationOnce(async () => rows.slice(0, 3))
      .mockImplementationOnce(async (args: any) => {
        const boundary = args.where.OR[0].createdAt.lt as Date;
        return rows.filter((row) => row.createdAt < boundary).slice(0, 3);
      });

    const firstRes = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log?limit=2",
      headers: authHeader(),
    });
    expect(firstRes.statusCode).toBe(200);
    const first = firstRes.json();
    expect(first.events.map((event: any) => event.id)).toEqual(["a1", "a2"]);
    expect(first.meta).toMatchObject({
      hasMore: true,
      limit: 2,
      nextCursor: encodeCursor(rows[1].createdAt, "a2"),
    });

    const secondRes = await app.inject({
      method: "GET",
      url: `/groups/group_1/audit-log?limit=2&cursor=${first.meta.nextCursor}`,
      headers: authHeader(),
    });
    expect(secondRes.statusCode).toBe(200);
    const second = secondRes.json();
    expect(second.events.map((event: any) => event.id)).toEqual(["a3", "a4"]);
    expect(
      second.events.some((event: any) =>
        first.events.some((prior: any) => prior.id === event.id)
      )
    ).toBe(false);
    expect(second.meta.nextCursor).toBe(encodeCursor(rows[3].createdAt, "a4"));
  });

  it("returns 400 for an invalid date range", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for a limit above the bounded maximum", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log?limit=1000",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns an empty page cleanly", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "admin",
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-log",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      events: [],
      meta: { nextCursor: null, hasMore: false, limit: 50, order: "desc" },
    });
  });

  it("allows an active member to use the new filtered paginated endpoint", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "user_1",
      role: "member",
      status: "active",
    });
    prisma.auditLog.findMany.mockResolvedValueOnce([fakeEvent({ id: "a1" }), fakeEvent({ id: "a2" })]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/audit-logs?limit=1&action=expense.create",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
    expect(res.json().nextCursor).toBe("a1");
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2 }));
  });
});
