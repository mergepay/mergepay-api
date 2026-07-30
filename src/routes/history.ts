import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { serializeExpense, serializeSettlement } from "../serializers";
import { paginationQuerySchema, encodeCursor, decodeCursor } from "../lib/pagination";

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/history", { config: { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute" } } }, async (req) => {
    const auth = requireUser(req);
    historyQuerySchema.parse(req.query ?? {});

    const [expenses, settlements] = await Promise.all([
      prisma.expense.findMany({
        where: {
          OR: [
            { payerUserId: auth.id },
            { shares: { some: { userId: auth.id } } },
          ],
          ...cursorFilter,
        },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: takeCount,
      }),
      prisma.settlement.findMany({
        where: { 
          OR: [{ fromUserId: auth.id }, { toUserId: auth.id }],
          ...cursorFilter,
        },
        include: { from: true, to: true },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: takeCount,
      }),
    ]);

    // Merge and sort by createdAt desc, then id desc
    const entries = [
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
      if (a.createdAt < b.createdAt) return 1;
      if (a.createdAt > b.createdAt) return -1;
      return a.id < b.id ? 1 : -1;
    });

    const hasMore = entries.length > limit;
    const results = hasMore ? entries.slice(0, limit) : entries;
    const nextCursor = hasMore
      ? encodeCursor(
          results[results.length - 1].createdAt,
          results[results.length - 1].id
        )
      : null;

    return {
      entries: results.map((r) => ({
        type: r.type,
        ...r.data,
      })),
      meta: { nextCursor, hasMore },
    };
  });
}
