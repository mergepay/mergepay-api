import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class UniqueConstraintError extends Error {
    code = "P2002";
    clientVersion = "test";
    constructor() {
      super("Unique constraint failed");
      this.name = "PrismaClientKnownRequestError";
    }
  }

  const keyOf = (where: any) => {
    const c = where.userId_scope_key ?? where;
    return `${c.userId}|${c.scope}|${c.key}`;
  };

  const rows = new Map<string, any>();
  const idempotencyKey = {
    findUnique: vi.fn(async ({ where }: any) => rows.get(keyOf(where)) ?? null),
    create: vi.fn(async ({ data }: any) => {
      const id = keyOf(data);
      if (rows.has(id)) throw new UniqueConstraintError();
      const row = { ...data, createdAt: new Date(), updatedAt: new Date() };
      rows.set(id, row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const id = keyOf(where);
      const existing = rows.get(id);
      if (!existing) throw new Error("record not found");
      const row = { ...existing, ...data, updatedAt: new Date() };
      rows.set(id, row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const id = `${where.userId}|${where.scope}|${where.key}`;
      const existing = rows.get(id);
      if (!existing) return { count: 0 };
      if (where.requestHash && existing.requestHash !== where.requestHash) return { count: 0 };
      const staleBefore = where.OR?.find((c: any) => c.status === "in_progress")?.updatedAt?.lt;
      const claimable =
        existing.status === "failed" ||
        (existing.status === "in_progress" &&
          staleBefore instanceof Date &&
          existing.updatedAt < staleBefore);
      if (!claimable) return { count: 0 };
      rows.set(id, { ...existing, ...data, updatedAt: new Date() });
      return { count: 1 };
    }),
  };

  const user = (id: string) => ({
    id,
    stellarPublicKey: `G${id.toUpperCase().padEnd(55, "A")}`,
    displayName: id,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  const prisma: any = {
    idempotencyKey,
    groupMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    group: { findUnique: vi.fn() },
    expense: { create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };

  return { rows, prisma, UniqueConstraintError, user };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("@prisma/client", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: h.UniqueConstraintError,
    },
  };
});

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import { IDEMPOTENCY_HEADER } from "../../src/plugins/idempotency";

const prisma = h.prisma;
const rows = h.rows;
const USER_ID = "user_1";
const GROUP_ID = "group_1";

function authHeader(userId = USER_ID) {
  return {
    authorization: `Bearer ${signToken({
      id: userId,
      stellarPublicKey: `G${userId.toUpperCase().padEnd(55, "A")}`,
    })}`,
  };
}

function expensePayload(overrides: Record<string, unknown> = {}) {
  return {
    title: "Dinner",
    amount: "100.0000000",
    assetCode: "XLM",
    splitType: "equal",
    shares: [{ userId: USER_ID }, { userId: "user_2" }],
    ...overrides,
  };
}

function createdExpense() {
  return {
    id: "expense_1",
    groupId: GROUP_ID,
    payerUserId: USER_ID,
    title: "Dinner",
    description: null,
    amount: "100.0000000",
    assetCode: "XLM",
    assetIssuer: null,
    splitType: "equal",
    memo: "memo1",
    receiptUrl: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    payer: h.user(USER_ID),
    shares: [
      {
        id: "s1",
        expenseId: "expense_1",
        userId: USER_ID,
        shareAmount: "50.0000000",
        status: "settled",
        user: h.user(USER_ID),
      },
      {
        id: "s2",
        expenseId: "expense_1",
        userId: "user_2",
        shareAmount: "50.0000000",
        status: "pending",
        user: h.user("user_2"),
      },
    ],
  };
}

describe("POST /groups/:id/expenses — idempotency", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    rows.clear();
    app = await buildApp({ rateLimit: "off" });

    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, archived: false });
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: GROUP_ID,
      userId: USER_ID,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValue([{ userId: USER_ID }, { userId: "user_2" }]);
    prisma.expense.create.mockResolvedValue(createdExpense());
    prisma.auditLog.create.mockResolvedValue({});
  });

  async function create(body: unknown, key?: string, groupId = GROUP_ID, userId = USER_ID) {
    const headers: Record<string, string> = { ...authHeader(userId) };
    if (key) headers[IDEMPOTENCY_HEADER] = key;
    return app.inject({
      method: "POST",
      url: `/groups/${groupId}/expenses`,
      headers,
      payload: body as any,
    });
  }

  it("rejects missing X-Idempotency-Key with 400", async () => {
    const res = await create(expensePayload());
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("MISSING_IDEMPOTENCY_KEY");
    expect(prisma.expense.create).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("rejects malformed X-Idempotency-Key with 400", async () => {
    const res = await create(expensePayload(), "bad key!");
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(prisma.expense.create).not.toHaveBeenCalled();
  });

  it("checks membership before a missing key", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);
    const res = await create(expensePayload(), undefined, GROUP_ID, "outsider");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("checks membership before a supplied key is reserved", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);
    const res = await create(expensePayload(), "non-member-key", GROUP_ID, "outsider");
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("creates expense and stores completed reservation", async () => {
    const res = await create(expensePayload(), "create-key-1");
    expect(res.statusCode).toBe(200);
    expect(res.json().expense.id).toBe("expense_1");
    expect(prisma.expense.create).toHaveBeenCalledOnce();
    const row = [...rows.values()][0];
    expect(row.scope).toBe("expense.create");
    expect(row.status).toBe("completed");
    expect(row.statusCode).toBe(200);
  });

  it("replays same key+group+body without re-executing", async () => {
    const first = await create(expensePayload(), "create-key-2");
    const second = await create(expensePayload(), "create-key-2");
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.json()).toEqual(first.json());
    expect(prisma.expense.create).toHaveBeenCalledOnce();
  });

  it("returns 409 when same key is reused for a different group", async () => {
    await create(expensePayload(), "create-key-3", GROUP_ID);
    prisma.group.findUnique.mockResolvedValue({ id: "group_2", archived: false });
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_2",
      userId: USER_ID,
      role: "member",
    });
    const second = await create(expensePayload(), "create-key-3", "group_2");
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(prisma.expense.create).toHaveBeenCalledOnce();
  });

  it("returns 409 when same key is reused with different body", async () => {
    await create(expensePayload(), "create-key-4");
    const second = await create(expensePayload({ amount: "200.0000000" }), "create-key-4");
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("does not cache failed requests and allows retry with same key", async () => {
    prisma.expense.create.mockRejectedValueOnce(new Error("db down"));
    const failed = await create(expensePayload(), "create-key-5");
    expect(failed.statusCode).toBe(500);

    prisma.expense.create.mockResolvedValueOnce(createdExpense());
    const retry = await create(expensePayload(), "create-key-5");
    expect(retry.statusCode).toBe(200);
    expect(prisma.expense.create).toHaveBeenCalledTimes(2);
  });
});
