/**
 * Group expense history: pagination combined with filtering.
 *
 * The pagination contract itself is covered by tests/pagination-contract.test.ts.
 * These tests are about the filters #265 adds — that each one narrows the query
 * it claims to, that they compose, and that paging still works once a filter is
 * applied.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { signToken } from "../../src/plugins/auth";
import {
  assertValidRange,
  expenseFilters,
  expenseListQuerySchema,
  expenseStatusFilter,
} from "../../src/services/expenses";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  });
  return {
    prisma: {
      expense: model(),
      groupMember: model(),
      group: model(),
      user: model(),
      $transaction: vi.fn(async (arg: any) =>
        typeof arg === "function" ? arg(h.prisma) : Promise.all(arg)
      ),
    },
  };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

const GROUP_ID = "group_1";
const USER_ID = "user_1";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authHeader(userId = USER_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

function fakeUser(id = USER_ID) {
  return {
    id,
    stellarPublicKey: PUBLIC_KEY,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function fakeExpense(over: Record<string, unknown> = {}) {
  return {
    id: "exp_1",
    groupId: GROUP_ID,
    payerUserId: USER_ID,
    title: "Dinner",
    description: null,
    amount: "25.0000000",
    assetCode: "USDC",
    assetIssuer: null,
    splitType: "equal",
    memo: null,
    receiptUrl: null,
    createdAt: new Date("2026-02-01T00:00:00Z"),
    payer: fakeUser(),
    shares: [],
    ...over,
  };
}

/** The `where` handed to Prisma by the most recent list request. */
function lastWhere(): any {
  const calls = prisma.expense.findMany.mock.calls;
  return (calls[calls.length - 1]?.[0] as any)?.where;
}

/** Every condition in an AND-composed where clause, flattened. */
function conditions(where: any): any[] {
  return where?.AND ?? [where];
}

async function list(query: string) {
  return app.inject({
    method: "GET",
    url: `/groups/${GROUP_ID}/expenses${query}`,
    headers: authHeader(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  });
  prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, name: "Trip" });
  prisma.expense.findMany.mockResolvedValue([]);
  prisma.expense.count.mockResolvedValue(0);
});

describe("GET /groups/:id/expenses — filter validation", () => {
  it("accepts a request with no filters and keeps the unfiltered query shape", async () => {
    const res = await list("");

    expect(res.statusCode).toBe(200);
    // No filters means no AND wrapper: the query is what it always was.
    expect(lastWhere().groupId).toBe(GROUP_ID);
    expect(lastWhere().AND).toBeUndefined();
  });

  it("rejects an unknown asset", async () => {
    const res = await list("?asset=DOGE");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown status", async () => {
    const res = await list("?status=REFUNDED");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-ISO date", async () => {
    const res = await list("?startDate=last-tuesday");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects a reversed date range rather than silently returning nothing", async () => {
    const res = await list(
      "?startDate=2026-03-01T00:00:00Z&endDate=2026-01-01T00:00:00Z"
    );

    expect(res.statusCode).toBe(400);
    // Matches the audit-log route's convention for the same mistake.
    expect(res.json().code).toBe("INVALID_RANGE");
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("still enforces the shared page size ceiling", async () => {
    const res = await list("?limit=9999");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /groups/:id/expenses — filters narrow the query", () => {
  it("filters by asset", async () => {
    await list("?asset=XLM");

    expect(conditions(lastWhere())).toContainEqual({ assetCode: "XLM" });
  });

  it("filters SETTLED by requiring every share settled", async () => {
    await list("?status=SETTLED");

    expect(conditions(lastWhere())).toContainEqual({
      shares: { some: {}, every: { status: "settled" } },
    });
  });

  it("filters PENDING by requiring some share unsettled", async () => {
    await list("?status=PENDING");

    expect(conditions(lastWhere())).toContainEqual({
      shares: { some: { status: { not: "settled" } } },
    });
  });

  it("filters by an inclusive date range", async () => {
    await list("?startDate=2026-01-01T00:00:00Z&endDate=2026-03-01T00:00:00Z");

    expect(conditions(lastWhere())).toContainEqual({
      createdAt: {
        gte: new Date("2026-01-01T00:00:00Z"),
        lte: new Date("2026-03-01T00:00:00Z"),
      },
    });
  });

  it("accepts an open-ended range", async () => {
    await list("?startDate=2026-01-01T00:00:00Z");

    expect(conditions(lastWhere())).toContainEqual({
      createdAt: { gte: new Date("2026-01-01T00:00:00Z") },
    });
  });

  it("composes asset and status filters together", async () => {
    await list("?asset=USDC&status=PENDING");

    const applied = conditions(lastWhere());
    expect(applied).toContainEqual({ groupId: GROUP_ID });
    expect(applied).toContainEqual({ assetCode: "USDC" });
    expect(applied).toContainEqual({
      shares: { some: { status: { not: "settled" } } },
    });
  });

  it("composes all filters at once and keeps the group scope", async () => {
    await list(
      "?asset=USDC&status=SETTLED&startDate=2026-01-01T00:00:00Z&endDate=2026-03-01T00:00:00Z"
    );

    const applied = conditions(lastWhere());
    expect(applied).toContainEqual({ groupId: GROUP_ID });
    expect(applied).toContainEqual({ assetCode: "USDC" });
    expect(applied).toContainEqual({
      shares: { some: {}, every: { status: "settled" } },
    });
    expect(applied).toContainEqual({
      createdAt: {
        gte: new Date("2026-01-01T00:00:00Z"),
        lte: new Date("2026-03-01T00:00:00Z"),
      },
    });
  });

  it("scopes to the group even when a filter is present", async () => {
    await list("?asset=XLM");

    expect(conditions(lastWhere())).toContainEqual({ groupId: GROUP_ID });
  });
});

describe("GET /groups/:id/expenses — pagination with filters", () => {
  it("returns a next cursor and hasMore when a filtered page is full", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      fakeExpense({
        id: `exp_${i}`,
        createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
      })
    );
    prisma.expense.findMany.mockResolvedValue(rows);

    const res = await list("?asset=USDC");
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.expenses).toHaveLength(50);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBeTruthy();
  });

  it("keeps the filter applied when resuming from a cursor", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      fakeExpense({
        id: `exp_${i}`,
        createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
      })
    );
    prisma.expense.findMany.mockResolvedValue(rows);

    const first = await list("?asset=USDC");
    const cursor = first.json().meta.nextCursor;

    await list(`?asset=USDC&cursor=${encodeURIComponent(cursor)}`);

    const applied = conditions(lastWhere());
    // The filter survives the second page...
    expect(applied).toContainEqual({ assetCode: "USDC" });
    // ...and the cursor is a separate condition rather than replacing it.
    expect(applied.some((c: any) => c.OR)).toBe(true);
  });

  it("rejects a malformed cursor before querying", async () => {
    const res = await list("?asset=USDC&cursor=not-a-cursor");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty page without a cursor when nothing matches", async () => {
    prisma.expense.findMany.mockResolvedValue([]);

    const res = await list("?asset=XLM&status=SETTLED");
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.expenses).toEqual([]);
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });
});

describe("GET /groups/:id/expenses — total count", () => {
  it("omits total by default and does not run a count query", async () => {
    const res = await list("");

    expect(res.json().meta.total).toBeUndefined();
    expect(prisma.expense.count).not.toHaveBeenCalled();
  });

  it("returns total when explicitly requested", async () => {
    prisma.expense.count.mockResolvedValue(137);

    const res = await list("?includeTotal=true");

    expect(res.json().meta.total).toBe(137);
    expect(prisma.expense.count).toHaveBeenCalledTimes(1);
  });

  it("counts the filtered set, not the whole group", async () => {
    prisma.expense.count.mockResolvedValue(4);

    await list("?includeTotal=true&asset=XLM");

    const countWhere = (prisma.expense.count.mock.calls[0]?.[0] as any)?.where;
    expect(conditions(countWhere)).toContainEqual({ assetCode: "XLM" });
  });

  it("counts without the cursor so the total is stable across pages", async () => {
    const rows = Array.from({ length: 51 }, (_, i) =>
      fakeExpense({
        id: `exp_${i}`,
        createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, i)),
      })
    );
    prisma.expense.findMany.mockResolvedValue(rows);
    prisma.expense.count.mockResolvedValue(51);

    const first = await list("?includeTotal=true");
    const cursor = first.json().meta.nextCursor;
    await list(`?includeTotal=true&cursor=${encodeURIComponent(cursor)}`);

    const countWhere = (prisma.expense.count.mock.calls[1]?.[0] as any)?.where;
    // No OR condition means the cursor was left out of the count.
    expect(conditions(countWhere).some((c: any) => c.OR)).toBe(false);
  });
});

describe("GET /groups/:id/expenses — authorization", () => {
  it("rejects a non-member before reading any expense row", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);

    const res = await list("?asset=USDC");

    expect(res.statusCode).toBe(403);
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses`,
    });

    expect(res.statusCode).toBe(401);
  });
});

describe("expense filter helpers", () => {
  it("treats SETTLED and PENDING as exact complements", () => {
    // A share-less expense must not count as settled, or it would appear in
    // the SETTLED page while matching neither in reality.
    expect(expenseStatusFilter("SETTLED").shares).toMatchObject({ some: {} });
    expect(expenseStatusFilter("PENDING").shares).toMatchObject({
      some: { status: { not: "settled" } },
    });
  });

  it("accepts lowercase status for the shared history route", () => {
    expect(expenseStatusFilter("settled")).toEqual(expenseStatusFilter("SETTLED"));
  });

  it("returns only the group scope when no filters are given", () => {
    expect(expenseFilters(GROUP_ID, {})).toEqual([{ groupId: GROUP_ID }]);
  });

  it("passes a valid or partial range", () => {
    expect(() =>
      assertValidRange("2026-01-01T00:00:00Z", "2026-03-01T00:00:00Z")
    ).not.toThrow();
    expect(() => assertValidRange("2026-01-01T00:00:00Z", undefined)).not.toThrow();
    expect(() => assertValidRange(undefined, undefined)).not.toThrow();
  });

  it("accepts equal start and end bounds", () => {
    expect(() =>
      assertValidRange("2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z")
    ).not.toThrow();
  });

  it("coerces includeTotal from its query-string form", () => {
    expect(expenseListQuerySchema.parse({ includeTotal: "true" }).includeTotal).toBe(true);
    expect(expenseListQuerySchema.parse({ includeTotal: "false" }).includeTotal).toBe(false);
    expect(expenseListQuerySchema.parse({}).includeTotal).toBeUndefined();
  });

  it("keeps the shared pagination defaults", () => {
    const parsed = expenseListQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.order).toBe("desc");
  });
});
