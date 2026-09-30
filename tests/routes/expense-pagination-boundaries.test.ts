/**
 * GET /groups/:id/expenses — pagination boundaries (#710).
 *
 * The pagination contract is covered generally by tests/pagination-contract.test.ts
 * and the filters by tests/routes/expenses.test.ts. This file pins the *edges*:
 * what happens at the minimum and maximum page sizes, when the result set is
 * exactly one page, and that the query stays a bounded read (`limit + 1`) no
 * matter what the client asks for.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { signToken } from "../../src/plugins/auth";
import { MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from "../../src/lib/pagination";

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
    createdAt: new Date("2026-02-01T00:00:00Z"),
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

/** N expenses with distinct, strictly increasing createdAt timestamps. */
function pageOfExpenses(n: number, startIndex = 0) {
  return Array.from({ length: n }, (_, i) =>
    fakeExpense({
      id: `exp_${startIndex + i}`,
      createdAt: new Date(Date.UTC(2026, 1, 1, 0, 0, startIndex + i)),
    })
  );
}

function lastArgs(): { where: any; orderBy: any; take?: number } {
  const calls = prisma.expense.findMany.mock.calls;
  return calls[calls.length - 1]?.[0] ?? {};
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

describe("GET /groups/:id/expenses — page size validation", () => {
  it("rejects limit=0 (below the minimum) with VALIDATION_ERROR", async () => {
    const res = await list("?limit=0");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("rejects a negative limit", async () => {
    const res = await list("?limit=-5");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it(`accepts limit=${MAX_PAGE_SIZE} (the ceiling itself is valid)`, async () => {
    const res = await list(`?limit=${MAX_PAGE_SIZE}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().meta.limit).toBe(MAX_PAGE_SIZE);
  });

  it(`rejects limit=${MAX_PAGE_SIZE + 1} rather than silently clamping`, async () => {
    const res = await list(`?limit=${MAX_PAGE_SIZE + 1}`);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("rejects a non-numeric limit", async () => {
    const res = await list("?limit=many");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects a non-integer limit", async () => {
    const res = await list("?limit=2.5");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("defaults to the shared page size when limit is omitted", async () => {
    const res = await list("");

    expect(res.statusCode).toBe(200);
    expect(res.json().meta.limit).toBe(DEFAULT_PAGE_SIZE);
  });
});

describe("GET /groups/:id/expenses — bounded read contract", () => {
  it("fetches exactly limit + 1 rows, never more", async () => {
    await list("?limit=7");

    expect(lastArgs().take).toBe(8);
  });

  it("fetches MAX_PAGE_SIZE + 1 even when no limit is given", async () => {
    await list("");

    expect(lastArgs().take).toBe(DEFAULT_PAGE_SIZE + 1);
  });

  it("the take is bounded by the request, not by the table size", async () => {
    // Even if the group has thousands of expenses, the query asks for
    // limit + 1 rows — the whole point of cursor pagination.
    prisma.expense.count.mockResolvedValue(5000);

    await list("?limit=3&includeTotal=true");

    expect(lastArgs().take).toBe(4);
  });
});

describe("GET /groups/:id/expenses — page boundaries", () => {
  it("returns the full page and no cursor when rows equal the limit exactly", async () => {
    prisma.expense.findMany.mockResolvedValue(pageOfExpenses(3));

    const res = await list("?limit=3");
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.expenses).toHaveLength(3);
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("slices to the limit and reports hasMore when one extra row exists", async () => {
    prisma.expense.findMany.mockResolvedValue(pageOfExpenses(4));

    const res = await list("?limit=3");
    const body = res.json();

    expect(body.expenses).toHaveLength(3);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBeTruthy();
  });

  it("returns a single expense with an empty meta cursor on a one-row group", async () => {
    prisma.expense.findMany.mockResolvedValue(pageOfExpenses(1));

    const res = await list("?limit=1");
    const body = res.json();

    expect(body.expenses).toHaveLength(1);
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
  });

  it("echoes the effective limit and order in meta", async () => {
    prisma.expense.findMany.mockResolvedValue(pageOfExpenses(1));

    const res = await list("?limit=5&order=asc");
    const meta = res.json().meta;

    expect(meta.limit).toBe(5);
    expect(meta.order).toBe("asc");
    expect(meta).toHaveProperty("hasMore");
    expect(meta).toHaveProperty("nextCursor");
  });

  it("orders ascending from the oldest row when order=asc", async () => {
    prisma.expense.findMany.mockResolvedValue(pageOfExpenses(3, 10));

    await list("?limit=2&order=asc");

    expect(lastArgs().orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
  });

  it("rejects an order value outside asc|desc", async () => {
    const res = await list("?order=middle");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});
