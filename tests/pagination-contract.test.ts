import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  buildPage,
  cursorFilter,
  cursorOrderBy,
  decodeCursor,
  encodeCursor,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../src/lib/pagination";
import { signToken } from "../src/plugins/auth";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
  });
  return {
    prisma: {
      expense: model(),
      settlement: model(),
      treasuryTransaction: model(),
      anchorSession: model(),
      groupMember: model(),
      group: model(),
      user: model(),
      $transaction: vi.fn(async (arg: any) =>
        typeof arg === "function" ? arg(h.prisma) : Promise.all(arg)
      ),
    },
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

const GROUP_ID = "group_1";
const USER_ID = "user_1";

function authHeader(userId = USER_ID) {
  const token = signToken({
    id: userId,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

function fakeUser(id = USER_ID) {
  return {
    id,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** Expenses that all share one timestamp — the tie-breaking case. */
function tiedExpenses(ids: string[], at = "2026-02-02T00:00:00Z") {
  return ids.map((id) => ({
    id,
    groupId: GROUP_ID,
    payerUserId: USER_ID,
    createdAt: new Date(at),
    amount: "10",
    assetCode: "XLM",
    assetIssuer: null,
    splitType: "equal",
    payer: fakeUser(),
    shares: [],
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  } as any);
  prisma.expense.findMany.mockResolvedValue([] as any);
  prisma.settlement.findMany.mockResolvedValue([] as any);
  prisma.treasuryTransaction.findMany.mockResolvedValue([] as any);
  prisma.anchorSession.findMany.mockResolvedValue([] as any);
  prisma.groupMember.findMany.mockResolvedValue([] as any);
});

describe("pagination primitives", () => {
  it("documents a safe default and a hard maximum page size", () => {
    expect(paginationQuerySchema.parse({}).limit).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    expect(paginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) }).limit).toBe(
      MAX_PAGE_SIZE
    );
    expect(() => paginationQuerySchema.parse({ limit: MAX_PAGE_SIZE + 1 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: -1 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: 1.5 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "many" })).toThrow();
  });

  it("defaults to newest-first and accepts an explicit direction", () => {
    expect(paginationQuerySchema.parse({}).order).toBe("desc");
    expect(paginationQuerySchema.parse({ order: "asc" }).order).toBe("asc");
    expect(() => paginationQuerySchema.parse({ order: "sideways" })).toThrow();
  });

  it("round-trips a cursor and rejects malformed ones", () => {
    const at = new Date("2026-02-02T03:04:05.000Z");
    const cursor = encodeCursor(at, "expense_9");
    expect(decodeCursor(cursor)).toEqual({ createdAt: at, id: "expense_9" });

    for (const bad of ["", "not-base64-!!!", "Zm9v", encodeCursor(at, "")]) {
      expect(decodeCursor(bad)).toBeNull();
    }
  });

  it("raises the standard error rather than silently restarting at page one", () => {
    expect(requireCursor(undefined)).toBeNull();
    expect(() => requireCursor("garbage-cursor")).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR", status: 400 })
    );
  });

  it("orders by the (createdAt, id) pair so ties resolve deterministically", () => {
    expect(cursorOrderBy("desc")).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(cursorOrderBy("asc")).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("builds a cursor comparison matching the sort in both directions", () => {
    const at = new Date("2026-02-02T00:00:00Z");
    const position = { createdAt: at, id: "5" };

    expect(cursorFilter(position, "desc")).toEqual({
      OR: [{ createdAt: { lt: at } }, { createdAt: at, id: { lt: "5" } }],
    });
    expect(cursorFilter(position, "asc")).toEqual({
      OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: "5" } }],
    });
    expect(cursorFilter(null)).toEqual({});
  });

  it("uses one lookahead row to decide hasMore without a count query", () => {
    expect(takeForPage(10)).toBe(11);

    const rows = tiedExpenses(["3", "2", "1"]);
    const page = buildPage(rows, 2, "desc");

    expect(page.items.map((r) => r.id)).toEqual(["3", "2"]);
    expect(page.meta).toEqual({
      nextCursor: encodeCursor(rows[1].createdAt, "2"),
      hasMore: true,
      limit: 2,
      order: "desc",
    });
  });

  it("reports no next page when the lookahead row is absent", () => {
    const page = buildPage(tiedExpenses(["3", "2"]), 5, "desc");
    expect(page.meta.hasMore).toBe(false);
    expect(page.meta.nextCursor).toBeNull();
  });

  it("reports an empty page without a cursor", () => {
    const page = buildPage([], 10, "desc");
    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({
      nextCursor: null,
      hasMore: false,
      limit: 10,
      order: "desc",
    });
  });
});

describe("list endpoints share one pagination contract", () => {
  const listRoutes: { name: string; url: string; key: string }[] = [
    { name: "group expenses", url: `/groups/${GROUP_ID}/expenses`, key: "expenses" },
    { name: "group ledger", url: `/groups/${GROUP_ID}/ledger`, key: "entries" },
    {
      name: "treasury history",
      url: `/groups/${GROUP_ID}/treasury/history`,
      key: "transactions",
    },
    { name: "anchor sessions", url: "/anchors/sessions", key: "sessions" },
    { name: "cross-group history", url: "/history", key: "expenses" },
    { name: "groups", url: "/groups", key: "groups" },
  ];

  for (const route of listRoutes) {
    it(`${route.name}: returns consistent metadata on an empty page`, async () => {
      const res = await app.inject({ method: "GET", url: route.url, headers: authHeader() });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body[route.key]).toEqual([]);
      expect(body.meta).toEqual({
        nextCursor: null,
        hasMore: false,
        limit: DEFAULT_PAGE_SIZE,
        order: "desc",
      });
    });

    it(`${route.name}: rejects a page size over the maximum`, async () => {
      const res = await app.inject({
        method: "GET",
        url: `${route.url}?limit=${MAX_PAGE_SIZE + 1}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    });

    it(`${route.name}: rejects a malformed cursor`, async () => {
      const res = await app.inject({
        method: "GET",
        url: `${route.url}?cursor=not-a-real-cursor-!!`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("INVALID_CURSOR");
    });
  }
});

describe("group expenses pagination", () => {
  it("returns the first page and a cursor pointing at its last row", async () => {
    const rows = tiedExpenses(["3", "2", "1"], "2026-02-03T00:00:00Z");
    prisma.expense.findMany.mockResolvedValueOnce(rows as any);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?limit=2`,
      headers: authHeader(),
    });

    const body = res.json();
    expect(body.expenses.map((e: any) => e.id)).toEqual(["3", "2"]);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBe(encodeCursor(rows[1].createdAt, "2"));
  });

  it("resumes strictly after the cursor, breaking ties on id", async () => {
    const at = new Date("2026-02-02T00:00:00Z");
    const cursor = encodeCursor(at, "2");

    await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?limit=2&cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.expense.findMany.mock.calls[0][0] as any;
    expect(args.where.OR).toEqual([
      { createdAt: { lt: at } },
      { createdAt: at, id: { lt: "2" } },
    ]);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("keeps the query bounded rather than loading the result set", async () => {
    await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?limit=25`,
      headers: authHeader(),
    });

    const args = prisma.expense.findMany.mock.calls[0][0] as any;
    expect(args.take).toBe(26);
    expect(args.skip).toBeUndefined();
  });

  it("walks a tied-timestamp page set without duplicating or skipping a row", async () => {
    // Six rows sharing one identical timestamp: exactly the case a plain
    // `ORDER BY createdAt` resolves arbitrarily. This stand-in applies the
    // (createdAt, id) row comparison the way Postgres would, so the walk below
    // exercises the real cursor arithmetic.
    const all = tiedExpenses(["f", "e", "d", "c", "b", "a"]);
    prisma.expense.findMany.mockImplementation(async (args: any) => {
      const or = args.where?.OR as
        | [{ createdAt: { lt: Date } }, { createdAt: Date; id: { lt: string } }]
        | undefined;

      const eligible = or
        ? all.filter((row) => {
            const boundaryAt = or[1].createdAt.getTime();
            const rowAt = row.createdAt.getTime();
            return rowAt < boundaryAt || (rowAt === boundaryAt && row.id < or[1].id.lt);
          })
        : all;

      return eligible.slice(0, args.take) as any;
    });

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = `/groups/${GROUP_ID}/expenses?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const body = (await app.inject({ method: "GET", url, headers: authHeader() })).json();
      seen.push(...body.expenses.map((e: any) => e.id));
      cursor = body.meta.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toEqual(["f", "e", "d", "c", "b", "a"]);
    expect(new Set(seen).size).toBe(seen.length);
    prisma.expense.findMany.mockReset();
    prisma.expense.findMany.mockResolvedValue([] as any);
  });

  it("supports ascending order with a matching cursor comparison", async () => {
    const at = new Date("2026-02-02T00:00:00Z");
    const cursor = encodeCursor(at, "2");

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?limit=2&order=asc&cursor=${cursor}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().meta.order).toBe("asc");
    const args = prisma.expense.findMany.mock.calls[0][0] as any;
    expect(args.orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(args.where.OR).toEqual([
      { createdAt: { gt: at } },
      { createdAt: at, id: { gt: "2" } },
    ]);
  });
});

describe("pagination never widens access", () => {
  it("checks membership before reading any row", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null as any);
    prisma.group.findUnique.mockResolvedValueOnce({ id: GROUP_ID } as any);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?limit=5`,
      headers: authHeader("outsider"),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("rejects a non-member even when they present a valid-looking cursor", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null as any);
    prisma.group.findUnique.mockResolvedValueOnce({ id: GROUP_ID } as any);
    const cursor = encodeCursor(new Date("2026-02-02T00:00:00Z"), "expense_from_elsewhere");

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?cursor=${cursor}`,
      headers: authHeader("outsider"),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("keeps the resource scope in the query, not the cursor", async () => {
    // A cursor minted for one group, replayed against another the caller *is*
    // a member of, can only move the page boundary — the groupId filter still
    // decides which rows are visible, and the cursor's id appears only as the
    // ordering tie-breaker, never as a scope of its own.
    const at = new Date("2026-02-02T00:00:00Z");
    const foreignCursor = encodeCursor(at, "row_from_another_group");

    await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?cursor=${foreignCursor}`,
      headers: authHeader(),
    });

    const args = prisma.expense.findMany.mock.calls[0][0] as any;
    expect(args.where.groupId).toBe(GROUP_ID);
    expect(Object.keys(args.where).sort()).toEqual(["OR", "groupId"]);
    expect(args.where.OR).toEqual([
      { createdAt: { lt: at } },
      { createdAt: at, id: { lt: "row_from_another_group" } },
    ]);
  });

  it("scopes the caller's own history and anchor sessions to the caller", async () => {
    await app.inject({ method: "GET", url: "/history", headers: authHeader() });
    const historyArgs = prisma.expense.findMany.mock.calls[0][0] as any;
    expect(JSON.stringify(historyArgs.where.OR)).toContain(USER_ID);

    await app.inject({ method: "GET", url: "/anchors/sessions", headers: authHeader() });
    const sessionArgs = prisma.anchorSession.findMany.mock.calls[0][0] as any;
    expect(sessionArgs.where.userId).toBe(USER_ID);
  });
});

describe("group ledger pagination", () => {
  it("reads every interleaved table with the same bounded window and ordering", async () => {
    await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/ledger?limit=10`,
      headers: authHeader(),
    });

    for (const model of [prisma.expense, prisma.settlement, prisma.treasuryTransaction]) {
      const args = model.findMany.mock.calls[0][0] as any;
      expect(args.take).toBe(11);
      expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
      expect(args.where.groupId).toBe(GROUP_ID);
    }
  });

  it("merges the three sources into one deterministically ordered page", async () => {
    prisma.expense.findMany.mockResolvedValueOnce([
      {
        id: "exp_1",
        createdAt: new Date("2026-03-03T00:00:00Z"),
        amount: "10",
        assetCode: "XLM",
        assetIssuer: null,
        splitType: "equal",
        payerUserId: USER_ID,
        payer: fakeUser(),
        shares: [],
      },
    ] as any);
    prisma.settlement.findMany.mockResolvedValueOnce([
      {
        id: "set_1",
        createdAt: new Date("2026-03-02T00:00:00Z"),
        amount: "5",
        assetCode: "XLM",
        assetIssuer: null,
        status: "confirmed",
        fromUserId: USER_ID,
        toUserId: "user_2",
        from: fakeUser(),
        to: fakeUser("user_2"),
      },
    ] as any);
    prisma.treasuryTransaction.findMany.mockResolvedValueOnce([
      {
        id: "tre_1",
        createdAt: new Date("2026-03-01T00:00:00Z"),
        amount: "2",
        assetCode: "XLM",
        assetIssuer: null,
        status: "confirmed",
        direction: "deposit",
        user: fakeUser(),
      },
    ] as any);

    const body = (
      await app.inject({
        method: "GET",
        url: `/groups/${GROUP_ID}/ledger?limit=10`,
        headers: authHeader(),
      })
    ).json();

    expect(body.entries.map((e: any) => e.type)).toEqual([
      "expense",
      "settlement",
      "treasury",
    ]);
    // Row ids are not leaked as a bare `id` field on ledger entries.
    expect(body.entries[0].id).toBeUndefined();
    expect(body.meta.hasMore).toBe(false);
  });
});
