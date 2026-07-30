import { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import { serializeExpense, serializeSettlement } from "../serializers";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";

export default async function historyRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Cross-group history for the authenticated user.
  //
  // Expenses and settlements are separate resources with separate cursors, so
  // a client can page each independently — merging them into one stream would
  // make a single cursor ambiguous. Both use the shared pagination contract,
  // and both are scoped to rows the caller is a party to; the cursor only ever
  // moves the page boundary inside that scope.
  app.get("/history", rateLimited("history"), async (req) => {
    const auth = requireUser(req);
    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    const { cursor: settlementCursor } = paginationQuerySchema
      .pick({ cursor: true })
      .parse({ cursor: (req.query as Record<string, unknown> | undefined)?.settlementCursor });

    const expensePosition = requireCursor(cursor);
    const settlementPosition = requireCursor(settlementCursor);

    const [expenses, settlements] = await Promise.all([
      prisma.expense.findMany({
        where: {
          OR: [{ payerUserId: auth.id }, { shares: { some: { userId: auth.id } } }],
          ...cursorFilter(expensePosition, order),
        },
        include: { payer: true, shares: { include: { user: true } } },
        orderBy: cursorOrderBy(order),
        take: takeForPage(limit),
      }),
      prisma.settlement.findMany({
        where: {
          OR: [{ fromUserId: auth.id }, { toUserId: auth.id }],
          ...cursorFilter(settlementPosition, order),
        },
        include: { from: true, to: true },
        orderBy: cursorOrderBy(order),
        take: takeForPage(limit),
      }),
    ]);

    const expensePage = buildPage(expenses, limit, order);
    const settlementPage = buildPage(settlements, limit, order);

    return {
      expenses: expensePage.items.map(serializeExpense),
      settlements: settlementPage.items.map(serializeSettlement),
      meta: expensePage.meta,
      settlementMeta: settlementPage.meta,
    };
  });
}
