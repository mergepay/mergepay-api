import { describe, it, expect, beforeEach, vi } from "vitest";
import { signToken } from "../../src/plugins/auth";
import { DEFAULT_PAGE_SIZE, GROUP_LIST_MAX_PAGE_SIZE } from "../../src/lib/pagination";

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

describe("Group Expense Category Filtering and Page Pagination (#800)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const prisma = h.prisma;

  const GROUP_ID = "group_test_800";
  const USER_ID = "user_test_800";
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
      description: "dinner with team category:meals",
      amount: "25.0000000",
      assetCode: "USDC",
      assetIssuer: null,
      splitType: "equal",
      memo: "meals",
      receiptUrl: null,
      createdAt: new Date("2026-02-01T00:00:00Z"),
      payer: fakeUser(),
      shares: [],
      ...over,
    };
  }

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: caller is active member of group
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: GROUP_ID,
      userId: USER_ID,
      role: "member",
      joinedAt: new Date(),
    });

    app = await buildApp();
  });

  it("accepts page and limit parameters, applying skip and take to Prisma", async () => {
    prisma.expense.findMany.mockResolvedValueOnce([
      fakeExpense({ id: "exp_1" }),
      fakeExpense({ id: "exp_2" }),
    ]);
    prisma.expense.count.mockResolvedValueOnce(12);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?page=2&limit=5`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expenses).toHaveLength(2);
    expect(body.meta).toMatchObject({
      page: 2,
      totalPages: 3,
      total: 12,
      limit: 5,
      hasMore: true,
    });

    // Check Prisma findMany called with skip = (2 - 1) * 5 = 5, take = 5
    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 5,
        take: 5,
      })
    );
  });

  it("filters expenses by categoryId using where conditions", async () => {
    prisma.expense.findMany.mockResolvedValueOnce([
      fakeExpense({ id: "exp_cat_1", description: "office supplies category:equipment" }),
    ]);
    prisma.expense.count.mockResolvedValueOnce(1);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?page=1&limit=10&categoryId=equipment`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expenses).toHaveLength(1);
    expect(body.meta).toMatchObject({
      page: 1,
      totalPages: 1,
      total: 1,
      limit: 10,
      hasMore: false,
    });

    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { groupId: GROUP_ID },
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  description: expect.objectContaining({ contains: "equipment" }),
                }),
                expect.objectContaining({
                  memo: expect.objectContaining({ equals: "equipment" }),
                }),
              ]),
            }),
          ]),
        }),
      })
    );
  });

  it("rejects invalid page query (page=0 or negative) with 400 bad request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?page=0`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });

  it("rejects invalid limit query exceeding the group-list maximum with 400 bad request", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?limit=${GROUP_LIST_MAX_PAGE_SIZE + 1}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
  });

  it("combines categoryId with date ranges and asset filter", async () => {
    prisma.expense.findMany.mockResolvedValueOnce([]);
    prisma.expense.count.mockResolvedValueOnce(0);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${GROUP_ID}/expenses?page=1&categoryId=travel&asset=USDC&startDate=2026-01-01T00:00:00Z&endDate=2026-12-31T23:59:59Z`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.expense.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            { groupId: GROUP_ID },
            { assetCode: "USDC" },
          ]),
        }),
      })
    );
  });
});
