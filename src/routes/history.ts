import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { requireUser } from "../plugins/auth";
import { expenseStatusFilter } from "../services/expenses";
import { serializeExpense, serializeSettlement } from "../serializers";
import {
  paginationQuerySchema,
  cursorFilter,
  requireCursor,
  takeForPage,
  encodeCursor,
  type CursorPosition,
} from "../lib/pagination";

const historyQuerySchema = paginationQuerySchema.extend({
  assetCode: z.string().optional(),
  status: z.string().optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
});

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/history", { config: { rateLimit: { max: config.RATE_LIMIT_HISTORY, timeWindow: "1 minute" } } }, async (req) => {
    const auth = requireUser(req);
    const query = historyQuerySchema.parse(req.query);
    const position = requireCursor(query.cursor);
    const cursorCondition = cursorFilter(position, query.order);

    const assetFilter = query.assetCode ? { assetCode: query.assetCode } : {};

    const dateFilter: Record<string, unknown> = {};
    if (query.fromDate) {
      dateFilter.createdAt = { gte: new Date(query.fromDate) };
    }
    if (query.toDate) {
      dateFilter.createdAt = {
        ...(dateFilter.createdAt as object | undefined),
        lte: new Date(query.toDate),
      };
    }

    const takeCount = takeForPage(query.limit);

    const [expenses, settlements] = await Promise.all([
      prisma.expense.findMany({
        where: {
          AND: [
            {
              OR: [
                { payerUserId: auth.id },
                { shares: { some: { userId: auth.id } } },
              ],
            },
            cursorCondition,
            assetFilter,
            dateFilter,
            // `Expense` has no status column — settlement is tracked per
            // participant on `ExpenseShare`. Filtering the expense row
            // directly threw a Prisma validation error for any `?status=`.
            ...(query.status ? [expenseStatusFilter(query.status)] : []),
          ],
        },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: [{ createdAt: query.order }, { id: query.order }],
        take: takeCount,
      }),
      prisma.settlement.findMany({
        where: {
          AND: [
            { OR: [{ fromUserId: auth.id }, { toUserId: auth.id }] },
            cursorCondition,
            assetFilter,
            dateFilter,
            ...(query.status ? [{ status: query.status }] : []),
          ],
        },
        include: { from: true, to: true },
        orderBy: [{ createdAt: query.order }, { id: query.order }],
        take: takeCount,
      }),
    ]);

    const merged: (CursorPosition & { type: "expense" | "settlement"; data: unknown })[] = [
      ...expenses.map((e) => ({
        type: "expense" as const,
        createdAt: e.createdAt,
        id: e.id,
        data: serializeExpense(e),
      })),
      ...settlements.map((s) => ({
        type: "settlement" as const,
        createdAt: s.createdAt,
        id: s.id,
        data: serializeSettlement(s),
      })),
    ].sort((a, b) => {
      const dir = query.order === "desc" ? -1 : 1;
      if (a.createdAt.getTime() !== b.createdAt.getTime()) {
        return a.createdAt.getTime() > b.createdAt.getTime() ? dir : -dir;
      }
      return a.id > b.id ? dir : -dir;
    });

    const hasMore = merged.length > query.limit;
    const results = hasMore ? merged.slice(0, query.limit) : merged;
    const last = results[results.length - 1];
    const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return {
      expenses: results.map((r) => ({
        type: r.type,
        ...(r.data as object),
      })),
      meta: { nextCursor, hasMore, limit: query.limit, order: query.order },
    };
  });
}
