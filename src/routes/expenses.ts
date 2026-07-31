import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { computeShares, type SplitType } from "../services/settlement";
import { isPositive } from "../services/money";
import { shortCode } from "../services/codes";
import { audit } from "../services/audit";
import { validateAsset, validateAmount } from "../services/assets";
import { serializeExpense } from "../serializers";
import { paginationQuerySchema, encodeCursor, decodeCursor } from "../lib/pagination";

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

const expenseInclude = {
  payer: true,
  shares: { include: { user: true } },
} as const;

export default async function expenseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- create -----------------------------------------------------------------
  app.post("/groups/:id/expenses", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const body = createExpenseSchema.parse(req.body);
    validateAmount(body.amount);
    validateAsset(body.assetCode, body.assetIssuer ?? null);

    const payerUserId = body.payerUserId ?? auth.id;

    // All participants (and payer) must be members of the group.
    const memberIds = new Set(
      (
        await prisma.groupMember.findMany({
          where: { groupId },
          select: { userId: true },
        })
      ).map((m) => m.userId)
    );
    if (!memberIds.has(payerUserId)) {
      throw Errors.badRequest("invalid_payer", "Payer must be a group member");
    }
    for (const s of body.shares) {
      if (!memberIds.has(s.userId)) {
        throw Errors.badRequest(
          "invalid_participant",
          "All participants must be group members"
        );
      }
    }

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

      await tx.auditLog.create({
        data: {
          userId: auth.id,
          action: "expense.create",
          entityType: "expense",
          entityId: created.id,
          metadata: { groupId, amount: body.amount, assetCode: body.assetCode },
        },
      });

      return created;
    });
    await auditLog.log("EXPENSE_CREATED", auth.id, groupId, {
      expenseId: expense.id,
      amount: body.amount,
      title: body.title,
    });

    return { expense: serializeExpense(expense) };
  });

  // -- list -------------------------------------------------------------------
  app.get("/groups/:id/expenses", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    const { cursor, limit } = paginationQuerySchema.parse(req.query ?? {});
    await requireMembership(groupId, auth.id);

    let decodedCursor = null;
    if (cursor) {
      decodedCursor = decodeCursor(cursor);
      if (!decodedCursor) {
        throw Errors.badRequest("invalid_cursor", "The provided cursor is invalid");
      }
    }

    const expenses = await prisma.expense.findMany({
      where: {
        groupId,
        ...(decodedCursor && {
          OR: [
            { createdAt: { lt: decodedCursor.createdAt } },
            {
              createdAt: decodedCursor.createdAt,
              id: { lt: decodedCursor.id },
            },
          ],
        }),
      },
      include: expenseInclude,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = expenses.length > limit;
    const results = hasMore ? expenses.slice(0, limit) : expenses;
    const nextCursor = hasMore
      ? encodeCursor(
          results[results.length - 1].createdAt,
          results[results.length - 1].id
        )
      : null;

    return {
      expenses: results.map(serializeExpense),
      meta: { nextCursor, hasMore },
    };
  });

  // -- get one ----------------------------------------------------------------
  app.get("/expenses/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
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

    const expense = await prisma.expense.findUnique({ where: { id } });
    if (!expense) throw Errors.notFound("Expense not found");
    const ctx = await requireMembership(expense.groupId, auth.id);
    if (expense.payerUserId !== auth.id && ctx.role !== "admin") {
      throw Errors.forbidden("Only the payer or an admin can edit this expense");
    }

    const updated = await prisma.expense.update({
      where: { id },
      data: {
        ...(body.title !== undefined && { title: body.title }),
        ...(body.description !== undefined && { description: body.description }),
        ...(body.memo !== undefined && { memo: body.memo }),
        ...(body.receiptUrl !== undefined && { receiptUrl: body.receiptUrl }),
      },
      include: expenseInclude,
    });
    await auditLog.log("EXPENSE_UPDATED", auth.id, expense.groupId, { expenseId: id });
    return { expense: serializeExpense(updated) };
  });

  // -- delete -----------------------------------------------------------------
  app.delete("/expenses/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const expense = await prisma.expense.findUnique({
      where: { id },
      include: { shares: true },
    });
    if (!expense) throw Errors.notFound("Expense not found");
    const ctx = await requireMembership(expense.groupId, auth.id);
    if (expense.payerUserId !== auth.id && ctx.role !== "admin") {
      throw Errors.forbidden("Only the payer or an admin can delete this expense");
    }
    const hasSettled = expense.shares.some(
      (s) => s.status === "settled" && s.userId !== expense.payerUserId
    );
    if (hasSettled) {
      throw Errors.conflict(
        "expense_settled",
        "Cannot delete an expense that already has settled shares"
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.expense.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          userId: auth.id,
          action: "expense.delete",
          entityType: "expense",
          entityId: id,
        },
      });
    });
    await auditLog.log("EXPENSE_DELETED", auth.id, expense.groupId, { expenseId: id });
    return { ok: true };
  });
}