import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { computeShares, type SplitType } from "../services/settlement";
import { normalizeAmount } from "../services/money";
import { shortCode } from "../services/codes";
import { auditTx } from "../services/audit";
import { validateAsset, validateAmount } from "../services/assets";
import { serializeExpense } from "../serializers";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";

/** Every route in this file takes a single opaque resource id. */
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

const shareInput = z.object({
  userId: z.string(),
  amount: z.string().optional(),
  percent: z.number().optional(),
});

const createExpenseSchema = z.object({
  title: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  amount: z.string().min(1),
  assetCode: z.string().min(1).max(12),
  assetIssuer: z.string().nullable().optional(),
  splitType: z.enum(["equal", "custom", "percentage"]),
  shares: z.array(shareInput).min(1),
  payerUserId: z.string().optional(),
  memo: z.string().max(24).optional(),
  receiptUrl: z.string().nullable().optional(),
});

const updateExpenseSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  memo: z.string().max(24).optional(),
  receiptUrl: z.string().nullable().optional(),
});

const expenseInclude = {
  payer: true,
  shares: { include: { user: true } },
} as const;

export default async function expenseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- create -----------------------------------------------------------------
  app.post("/groups/:id/expenses", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = idParamSchema.parse(req.params);
    await requireMembership(groupId, auth.id);

    const body = createExpenseSchema.parse(req.body);
    validateAmount(body.amount);
    validateAsset(body.assetCode, body.assetIssuer ?? null);

    const payerUserId = body.payerUserId ?? auth.id;

    let computed;
    try {
      computed = computeShares(body.amount, body.splitType as SplitType, body.shares);
    } catch (e: any) {
      throw Errors.badRequest("invalid_split", e?.message ?? "Invalid split");
    }

    const memo = body.memo?.trim() || shortCode().slice(0, 8);

    const expense = await prisma.$transaction(async (tx) => {
      const created = await tx.expense.create({
        data: {
          groupId,
          payerUserId,
          title: body.title,
          description: body.description,
          amount: body.amount,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          splitType: body.splitType,
          memo,
          receiptUrl: body.receiptUrl ?? null,
          shares: {
            create: computed.map((c) => ({
              userId: c.userId,
              shareAmount: c.shareAmount,
              status: c.userId === payerUserId ? "settled" : "pending",
            })),
          },
        },
        include: expenseInclude,
      });

      await auditTx(tx, {
        userId: auth.id,
        groupId,
        action: "expense.create",
        entityType: "expense",
        entityId: created.id,
        metadata: { amount: body.amount, assetCode: body.assetCode },
      });

      return created;
    });

    return { expense: serializeExpense(expense) };
  });

  // -- list -------------------------------------------------------------------
  app.get("/groups/:id/expenses", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = idParamSchema.parse(req.params);
    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    // Membership is checked before any row is read, and the `groupId` filter
    // below is what scopes the page — never the cursor.
    await requireMembership(groupId, auth.id);

    const position = requireCursor(cursor);

    const expenses = await prisma.expense.findMany({
      where: { groupId, ...cursorFilter(position, order) },
      include: expenseInclude,
      orderBy: cursorOrderBy(order),
      take: takeForPage(limit),
    });

    const { items, meta } = buildPage(expenses, limit, order);
    return { expenses: items.map(serializeExpense), meta };
  });

  // -- get one ----------------------------------------------------------------
  app.get("/expenses/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = idParamSchema.parse(req.params);
    const expense = await prisma.expense.findUnique({
      where: { id },
      include: expenseInclude,
    });
    if (!expense) throw Errors.notFound("Expense not found");
    await requireMembership(expense.groupId, auth.id);
    return { expense: serializeExpense(expense) };
  });

  // -- update (metadata only) -------------------------------------------------
  app.patch("/expenses/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = updateExpenseSchema.parse(req.body);

    // The membership/role check and the update run in one transaction: a
    // concurrent removal or demotion of `auth.id` between the check and the
    // write cannot slip an unauthorized edit through.
    const updated = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw Errors.notFound("Expense not found");
      const ctx = await requireMembership(expense.groupId, auth.id, tx);
      if (expense.payerUserId !== auth.id && ctx.role !== "admin") {
        throw Errors.forbidden("Only the payer or an admin can edit this expense");
      }

      const result = await tx.expense.update({
        where: { id },
        data: {
          ...(body.title !== undefined && { title: body.title }),
          ...(body.description !== undefined && { description: body.description }),
          ...(body.memo !== undefined && { memo: body.memo }),
          ...(body.receiptUrl !== undefined && { receiptUrl: body.receiptUrl }),
        },
        include: expenseInclude,
      });

      await auditTx(tx, {
        userId: auth.id,
        groupId: expense.groupId,
        action: "expense.update",
        entityType: "expense",
        entityId: id,
      });

      return result;
    });
    return { expense: serializeExpense(updated) };
  });

  // -- delete -----------------------------------------------------------------
  app.delete("/expenses/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = idParamSchema.parse(req.params);

    // Same atomicity concern as the update route above: check and delete
    // happen in one transaction.
    await prisma.$transaction(async (tx) => {
      const found = await tx.expense.findUnique({
        where: { id },
        include: { shares: true },
      });
      if (!found) throw Errors.notFound("Expense not found");
      const ctx = await requireMembership(found.groupId, auth.id, tx);
      if (found.payerUserId !== auth.id && ctx.role !== "admin") {
        throw Errors.forbidden("Only the payer or an admin can delete this expense");
      }
      const hasSettled = found.shares.some(
        (s) => s.status === "settled" && s.userId !== found.payerUserId
      );
      if (hasSettled) {
        throw Errors.conflict(
          "expense_settled",
          "Cannot delete an expense that already has settled shares"
        );
      }

      await tx.expense.delete({ where: { id } });
      await auditTx(tx, {
        userId: auth.id,
        groupId: found.groupId,
        action: "expense.delete",
        entityType: "expense",
        entityId: id,
      });
    });
    return { ok: true };
  });
}