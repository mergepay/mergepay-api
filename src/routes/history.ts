import { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import { serializeExpense, serializeSettlement } from "../serializers";

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/history", rateLimited("history"), async (req) => {
    const auth = requireUser(req);

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
