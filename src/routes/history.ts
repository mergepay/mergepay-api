import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { requireUser } from "../plugins/auth";
import { serializeExpense, serializeSettlement } from "../serializers";

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/history", { config: { rateLimit: { max: config.RATE_LIMIT_HISTORY, timeWindow: "1 minute" } } }, async (req) => {
    const auth = requireUser(req);
    historyQuerySchema.parse(req.query ?? {});

    const [expenses, settlements] = await Promise.all([
      prisma.expense.findMany({
        where: {
          OR: [
            { payerUserId: auth.id },
            { shares: { some: { userId: auth.id } } },
          ],
        },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
      prisma.settlement.findMany({
        where: { OR: [{ fromUserId: auth.id }, { toUserId: auth.id }] },
        include: { from: true, to: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);

    return {
      expenses: expenses.map(serializeExpense),
      settlements: settlements.map(serializeSettlement),
    };
  });
}
