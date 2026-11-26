import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    settlement: model(),
    auditLog: model(),
    statusHistory: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(h.prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import {
  groupExpenseHistorySchema,
  listGroupExpenseHistory,
} from "../../src/services/expenses";
import { historyQuerySchema } from "../../src/routes/history";

const prisma = h.prisma;
const USER_ID = "user_test_882";
const GROUP_ID = "group_test_882";

let app: Awaited<ReturnType<typeof buildApp>>;

function authHeader(userId = USER_ID) {
  const token = signToken({
    id: userId,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

describe("Group Expense Settlement History Pagination & Filtering (#882)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();

    prisma.groupMember.findUnique.mockResolvedValue({
      id: "membership_1",
      userId: USER_ID,
      groupId: GROUP_ID,
      role: "member",
    });
    prisma.groupMember.findFirst.mockResolvedValue({
      id: "membership_1",
      userId: USER_ID,
      groupId: GROUP_ID,
      role: "member",
    });

    prisma.group.findUnique.mockResolvedValue({
      id: GROUP_ID,
      name: "Test Group",
    });
  });

  describe("Zod validation schemas", () => {
    it("validates historyQuerySchema with pagination and filtering fields", () => {
      const parsed = historyQuerySchema.parse({
        limit: 20,
        order: "asc",
        assetCode: "USDC",
        status: "completed",
        fromDate: "2026-01-01T00:00:00.000Z",
        toDate: "2026-06-01T00:00:00.000Z",
        groupId: GROUP_ID,
        includeTotal: "true",
        offset: 10,
      });

      expect(parsed.limit).toBe(20);
      expect(parsed.order).toBe("asc");
      expect(parsed.assetCode).toBe("USDC");
      expect(parsed.status).toBe("completed");
      expect(parsed.groupId).toBe(GROUP_ID);
      expect(parsed.includeTotal).toBe(true);
      expect(parsed.offset).toBe(10);
    });

    it("validates groupExpenseHistorySchema with defaults", () => {
      const parsed = groupExpenseHistorySchema.parse({});
      expect(parsed.limit).toBe(50);
      expect(parsed.order).toBe("desc");
      expect(parsed.offset).toBeUndefined();
      expect(parsed.includeTotal).toBeUndefined();
    });

    it("rejects invalid limit exceeding MAX_PAGE_SIZE", () => {
      expect(() => historyQuerySchema.parse({ limit: 500 })).toThrow();
    });

    it("rejects groupExpenseHistorySchema limit=0 (below minimum)", () => {
      expect(() => groupExpenseHistorySchema.parse({ limit: 0 })).toThrow();
    });

    it("rejects groupExpenseHistorySchema limit=-1 (negative)", () => {
      expect(() => groupExpenseHistorySchema.parse({ limit: -1 })).toThrow();
    });

    it("accepts groupExpenseHistorySchema limit=100 (at MAX_PAGE_SIZE boundary)", () => {
      const parsed = groupExpenseHistorySchema.parse({ limit: 100 });
      expect(parsed.limit).toBe(100);
    });

    it("rejects groupExpenseHistorySchema limit=101 (exceeds MAX_PAGE_SIZE)", () => {
      expect(() => groupExpenseHistorySchema.parse({ limit: 101 })).toThrow();
    });

    it("rejects historyQuerySchema limit=0", () => {
      expect(() => historyQuerySchema.parse({ limit: 0 })).toThrow();
    });

    it("rejects historyQuerySchema limit=-5", () => {
      expect(() => historyQuerySchema.parse({ limit: -5 })).toThrow();
    });

    it("accepts historyQuerySchema limit=100 (at MAX_PAGE_SIZE boundary)", () => {
      const parsed = historyQuerySchema.parse({ limit: 100 });
      expect(parsed.limit).toBe(100);
    });
  });

  describe("listGroupExpenseHistory service", () => {
    it("executes Prisma query with take, skip, and returns pagination metadata", async () => {
      const mockExpenses = [
        {
          id: "exp_1",
          createdAt: new Date("2026-05-10T10:00:00Z"),
          amount: "100.00",
          assetCode: "USDC",
        },
        {
          id: "exp_2",
          createdAt: new Date("2026-05-09T10:00:00Z"),
          amount: "50.00",
          assetCode: "USDC",
        },
      ];

      prisma.expense.findMany.mockResolvedValue(mockExpenses);
      prisma.expense.count.mockResolvedValue(25);

      const result = await listGroupExpenseHistory(
        GROUP_ID,
        {
          limit: 10,
          offset: 5,
          order: "desc",
          asset: "USDC",
          includeTotal: true,
        },
        {} as any
      );

      expect(prisma.expense.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 11,
          skip: 5,
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              { groupId: GROUP_ID },
              { assetCode: "USDC" },
            ]),
          }),
        })
      );

      expect(result.items).toHaveLength(2);
      expect(result.meta.limit).toBe(10);
      expect(result.meta.total).toBe(25);
      expect(result.meta.hasMore).toBe(false);
    });
  });

  describe("API Route Integration: GET /history with pagination and total", () => {
    it("returns expenses, settlements, and meta with total count", async () => {
      const now = new Date();
      prisma.expense.findMany.mockResolvedValue([
        {
          id: "exp_1",
          createdAt: now,
          amount: "20.00",
          assetCode: "XLM",
          payer: {
            id: USER_ID,
            stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            createdAt: now,
          },
          shares: [],
        },
      ]);
      prisma.settlement.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(1);
      prisma.settlement.count.mockResolvedValue(0);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/history?includeTotal=true&groupId=${GROUP_ID}`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.expenses).toBeDefined();
      expect(body.meta).toBeDefined();
      expect(body.meta.total).toBe(1);
      expect(body.meta.hasMore).toBe(false);
    });
  });

  describe("API Route Integration: GET /history with groupId filtering", () => {
    it("returns group history with pagination metadata and total", async () => {
      const now = new Date();
      prisma.expense.findMany.mockResolvedValue([
        {
          id: "exp_group_1",
          createdAt: now,
          amount: "80.00",
          assetCode: "USDC",
          payer: {
            id: USER_ID,
            stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            createdAt: now,
          },
          shares: [],
        },
      ]);
      prisma.settlement.findMany.mockResolvedValue([]);
      prisma.expense.count.mockResolvedValue(1);
      prisma.settlement.count.mockResolvedValue(0);

      const res = await app.inject({
        method: "GET",
        url: `/api/v1/history?groupId=${GROUP_ID}&includeTotal=true&limit=10`,
        headers: authHeader(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.expenses).toBeDefined();
      expect(body.expenses.length).toBe(1);
      expect(body.meta.limit).toBe(10);
      expect(body.meta.total).toBe(1);
      expect(body.meta.hasMore).toBe(false);
    });
  });
});
