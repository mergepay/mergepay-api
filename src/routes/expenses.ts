import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import {
  openApiBody,
  openApiEnvelope,
  openApiErrorResponses,
  openApiIdParams,
  openApiOkResponse,
  openApiResponse,
} from "../lib/openapi";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { requireGroupRole } from "../plugins/group-access";
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
import {
  createGroupExpense,
  expenseListQuerySchema,
  listGroupExpenses,
} from "../services/expenses";

/** Every route in this file takes a single opaque resource id. */
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

const expenseInclude = {
  payer: true,
  shares: { include: { user: true } },
} as const;

export default async function expenseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- create -----------------------------------------------------------------
  app.post(
    "/groups/:id/expenses",
    {
      preHandler: requireGroupRole("member", { param: "id" }),
      schema: {
        tags: ["Expenses"],
        summary: "Create an expense in a group",
        description:
          "Records a group expense and its payment split. The payer's share is settled immediately; every other participant's share is owed.",
        params: openApiIdParams(),
        body: openApiBody(createExpenseSchema),
        response: {
          ...openApiEnvelope("expense"),
          ...openApiErrorResponses(400, 401, 403, 404),
        },
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = idParamSchema.parse(req.params);

    const body = createExpenseSchema.parse(req.body);
    validateAmount(body.amount);
    const asset = validateAsset(body.assetCode, body.assetIssuer ?? null);

    const payerUserId = body.payerUserId ?? auth.id;
    // When the payer is the caller, the route's membership guard already proved
    // they are an active member — only a *different* payer needs a second
    // lookup.
    if (payerUserId !== auth.id) {
      const payerMembership = await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: payerUserId } },
        select: { userId: true },
      });
      if (!payerMembership) {
        throw Errors.badRequest("invalid_payer", "Payer must be an active group member");
      }
    }

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

    // A non-native asset can only be paid to an account that has trusted it.
    // Without this check the expense is created happily and every settlement
    // built from it fails on submission with op_no_trust — after members have
    // been asked to pay, which is the most expensive point to discover it.
    //
    // Native XLM needs no trustline, so it skips the Horizon round trip
    // entirely rather than paying for a lookup whose answer is always yes.
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

    // Expense row + participant splits + audit log are written as one unit in
    // createGroupExpense's `prisma.$transaction` — a failure on any of them
    // rolls the whole creation back (see src/services/expenses.ts).
    const expense = await createGroupExpense(
      {
        groupId,
        payerUserId,
        actorUserId: auth.id,
        title: body.title,
        description: body.description,
        amount: body.amount,
        assetCode: body.assetCode,
        assetIssuer: body.assetIssuer ?? null,
        splitType: body.splitType,
        memo,
        receiptUrl: body.receiptUrl ?? null,
        shares: computed.map((c) => ({
          userId: c.userId,
          shareAmount: c.shareAmount,
        })),
      },
      expenseInclude
    );

    return { expense: serializeExpense(expense) };
  });

  // -- list -------------------------------------------------------------------
  app.get(
    "/groups/:id/expenses",
    {
      preHandler: requireGroupRole("member", { param: "id" }),
      schema: {
        tags: ["Expenses"],
        summary: "List a group's expenses",
        description:
          "Returns a paginated, filterable list of the group's expenses. Requires membership.",
        params: openApiIdParams(),
        response: {
          ...openApiResponse(
            {
              expenses: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              meta: { type: "object", additionalProperties: true },
            },
            ["expenses", "meta"]
          ),
          ...openApiErrorResponses(400, 401, 403),
        },
      },
    },
    async (req) => {
    const { id: groupId } = idParamSchema.parse(req.params);
    // Membership was checked by the route guard before any row is read, and
    // the `groupId` filter the service applies is what scopes the page —
    // never the cursor.
    const query = expenseListQuerySchema.parse(req.query ?? {});

    const { items, meta } = await listGroupExpenses(groupId, query, expenseInclude);

    return { expenses: items.map(serializeExpense), meta };
  });

  // -- get one ----------------------------------------------------------------
  app.get(
    "/expenses/:id",
    {
      schema: {
        tags: ["Expenses"],
        summary: "Get an expense",
        description:
          "Returns a single expense with its payer and shares. Requires membership of the expense's group.",
        params: openApiIdParams(),
        response: {
          ...openApiEnvelope("expense"),
          ...openApiErrorResponses(401, 403, 404),
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
  });

  // -- update (metadata only) -------------------------------------------------
  app.patch(
    "/expenses/:id",
    {
      schema: {
        tags: ["Expenses"],
        summary: "Update an expense",
        description:
          "Updates expense metadata. Only the payer or a group admin may edit it.",
        params: openApiIdParams(),
        body: openApiBody(updateExpenseSchema),
        response: {
          ...openApiEnvelope("expense"),
          ...openApiErrorResponses(400, 401, 403, 404),
        },
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = idParamSchema.parse(req.params);
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
  app.delete(
    "/expenses/:id",
    {
      schema: {
        tags: ["Expenses"],
        summary: "Delete an expense",
        description:
          "Deletes an expense. Only the payer or a group admin may delete it, and only while no other participant's share is settled.",
        params: openApiIdParams(),
        response: {
          ...openApiOkResponse(),
          ...openApiErrorResponses(401, 403, 404, 409),
        },
      },
    },
    async (req) => {
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
