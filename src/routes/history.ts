import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { requireUser } from "../plugins/auth";
import { serializeExpense, serializeSettlement } from "../serializers";
import { paginationQuerySchema, decodeCursor, buildPaginatedResponse } from "../services/pagination";

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/history", async (req) => {
    const auth = requireUser(req);
    const query = paginationQuerySchema.parse(req.query);

    let cursorCondition: any = {};
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      cursorCondition = {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: { equals: cursor.createdAt }, id: { lt: cursor.id } },
        ],
      };
    }

    const statusFilter = query.status
      ? { status: query.status }
      : undefined;

    const assetFilter = query.assetCode
      ? { assetCode: query.assetCode }
      : undefined;

    const dateFilter: any = {};
    if (query.fromDate) {
      dateFilter.createdAt = { ...(dateFilter.createdAt || {}), gte: new Date(query.fromDate) };
    }
    if (query.toDate) {
      dateFilter.createdAt = { ...(dateFilter.createdAt || {}), lte: new Date(query.toDate) };
    }

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
          ],
        },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      }),
      prisma.settlement.findMany({
        where: {
          AND: [
            { OR: [{ fromUserId: auth.id }, { toUserId: auth.id }] },
            cursorCondition,
            statusFilter,
            assetFilter,
            dateFilter,
          ],
        },
        include: { from: true, to: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: query.limit + 1,
      }),
    ]);

    const expenseResult = buildPaginatedResponse(expenses, query.limit);
    const settlementResult = buildPaginatedResponse(settlements, query.limit);

    return {
      expenses: {
        items: expenseResult.items.map(serializeExpense),
        nextCursor: expenseResult.nextCursor,
      },
      settlements: {
        items: settlementResult.items.map(serializeSettlement),
        nextCursor: settlementResult.nextCursor,
      },
    };
  });
}
