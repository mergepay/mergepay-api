import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { openApiBody, openApiEnvelope, openApiIdParams } from "../lib/openapi";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { computeShares, type SplitType } from "../services/settlement";
import { shortCode } from "../services/codes";
import { serializeExpense } from "../serializers";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";
import { auditTx } from "../services/audit";
import { validateAsset, validateAmount } from "../services/assets";
import { assertParticipantsCanHoldAsset } from "../services/horizon";
import { createExpenseSchema, updateExpenseSchema } from "../validations/expense";
import { expenseListQuerySchema, listGroupExpenses } from "../services/expenses";

/** Every route in this file takes a single opaque resource id. */
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

const expenseInclude = {
  payer: true,
  shares: { include: { user: true } },
} as const;

export default async function expenseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);



      const body = createExpenseSchema.parse(req.body);
      validateAmount(body.amount);
      const asset = validateAsset(body.assetCode, body.assetIssuer ?? null);

      const payerUserId = body.payerUserId ?? auth.id;

      let computed;
      try {
        computed = computeShares(body.amount, body.splitType as SplitType, body.shares);
      } catch (e: any) {
        throw Errors.badRequest("invalid_split", e?.message ?? "Invalid split");
      }

      const participantIds = [...new Set(computed.map((share) => share.userId))];
      const members = await prisma.groupMember.findMany({
        where: { groupId, userId: { in: participantIds } },
        select: { userId: true, user: { select: { stellarPublicKey: true } } },
      });
      if (members.length !== participantIds.length) {
        throw Errors.badRequest("invalid_split", "Every split participant must be an active group member");
      }

      if (asset.type !== "native") {
        await assertParticipantsCanHoldAsset({
          participants: members.map((member) => ({
            userId: member.userId,
            stellarPublicKey: member.user.stellarPublicKey,
          })),
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
        });
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



  app.get(
    "/groups/:id/expenses",
    {
      schema: {
        tags: ["expenses"],
        summary: "List group expenses",
        description: "Return the paginated, filterable list of expenses for a group, including optional totals and status filtering.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        querystring: {
          type: "object",
          properties: {
            cursor: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 50 },
            order: { type: "string", enum: ["asc", "desc"] },
            asset: { type: ["string", "null"] },
            status: { type: ["string", "null"], enum: ["SETTLED", "PENDING", "OVERDUE"] },
            startDate: { type: ["string", "null"], format: "date-time" },
            endDate: { type: ["string", "null"], format: "date-time" },
            includeTotal: { type: ["boolean", "string", "null"] },
          },
          additionalProperties: true,
        },
        response: {
          200: {
            type: "object",
            properties: {
              expenses: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    groupId: { type: "string" },
                    payerUserId: { type: "string" },
                    title: { type: "string" },
                    description: { type: ["string", "null"] },
                    amount: { type: "string" },
                    assetCode: { type: "string" },
                    assetIssuer: { type: ["string", "null"] },
                    splitType: { type: "string" },
                    memo: { type: ["string", "null"] },
                    receiptUrl: { type: ["string", "null"] },
                    createdAt: { type: "string", format: "date-time" },
                  },
                },
              },
              meta: {
                type: "object",
                properties: {
                  nextCursor: { type: ["string", "null"] },
                  hasMore: { type: "boolean" },
                  total: { type: ["integer", "null"] },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id: groupId } = idParamSchema.parse(req.params);
      const query = expenseListQuerySchema.parse(req.query ?? {});

      await requireMembership(groupId, auth.id);

      const { items, meta } = await listGroupExpenses(groupId, query, expenseInclude);
      return { expenses: items.map(serializeExpense), meta };
    }
  );

  app.get(
    "/expenses/:id",
    {
      schema: {
        tags: ["expenses"],
        summary: "Get an expense by id",
        description: "Fetch one expense and its participant shares after verifying the caller is a group member.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              expense: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  groupId: { type: "string" },
                  payerUserId: { type: "string" },
                  title: { type: "string" },
                  description: { type: ["string", "null"] },
                  amount: { type: "string" },
                  assetCode: { type: "string" },
                  assetIssuer: { type: ["string", "null"] },
                  splitType: { type: "string" },
                  memo: { type: ["string", "null"] },
                  receiptUrl: { type: ["string", "null"] },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = idParamSchema.parse(req.params);
      const expense = await prisma.expense.findUnique({
        where: { id },
        include: expenseInclude,
      });
      if (!expense) throw Errors.notFound("Expense not found");
      await requireMembership(expense.groupId, auth.id);
      return { expense: serializeExpense(expense) };
    }
  );

  app.patch(
    "/expenses/:id",
    {
      schema: {
        tags: ["expenses"],
        summary: "Update expense metadata",
        description: "Update editable expense fields such as title, description, memo, or receipt URL, restricted to the payer or an admin.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        body: {
          type: "object",
          properties: {
            title: { type: "string", minLength: 1, maxLength: 80 },
            description: { type: ["string", "null"], maxLength: 500 },
            memo: { type: ["string", "null"], maxLength: 24 },
            receiptUrl: { type: ["string", "null"] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              expense: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  groupId: { type: "string" },
                  payerUserId: { type: "string" },
                  title: { type: "string" },
                  description: { type: ["string", "null"] },
                  amount: { type: "string" },
                  assetCode: { type: "string" },
                  assetIssuer: { type: ["string", "null"] },
                  splitType: { type: "string" },
                  memo: { type: ["string", "null"] },
                  receiptUrl: { type: ["string", "null"] },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = updateExpenseSchema.parse(req.body);

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
    }
  );

  app.delete(
    "/expenses/:id",
    {
      schema: {
        tags: ["expenses"],
        summary: "Delete an expense",
        description: "Delete an expense after confirming the caller has rights and the expense has no settled shares that would make deletion unsafe.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1, maxLength: 64 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: { ok: { type: "boolean" } },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = idParamSchema.parse(req.params);

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
    }
  );
}
