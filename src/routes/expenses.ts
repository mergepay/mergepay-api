import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import {
  openApiBody,
  openApiErrorResponses,
  openApiIdParams,
  openApiOkResponse,
  openApiQuery,
  openApiResponse,
  openApiSchemaRef,
} from "../lib/openapi";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireActiveMembership, requireMembership } from "../services/access";
import { requireGroupRole } from "../plugins/group-access";
import { requireExpensePayerOrAdmin } from "../middleware/group-guard";
import { validateRequest } from "../middleware/validate-request";
import { computeShares, isSettlementEngineError } from "../services/settlement";
import { shortCode } from "../services/codes";
import { serializeExpense } from "../serializers";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  GROUP_LIST_MAX_PAGE_SIZE,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";
import { auditTx, logActionTx } from "../services/audit";
import { AuditAction } from "../services/audit-actions";
import { validateAsset } from "../services/assets";
import { assertParticipantsCanHoldAsset } from "../services/horizon";
import {
  createExpenseSchema,
  updateExpenseSchema,
  type CreateExpenseInput,
  type UpdateExpenseInput,
} from "../validations/expense";
import { expenseListQuerySchema, listGroupExpenses } from "../services/expenses";
import { rateLimited } from "../lib/rate-limit";

/** Every route in this file takes a single opaque resource id. */
const idParamSchema = z.object({ id: z.string().min(1).max(64) });

const expenseInclude = {
  payer: true,
  shares: { include: { user: true } },
} as const;

export default async function expenseRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Every route below carries a `requireGroupRole` guard (issue #356), which
  // rejects a non-member before the handler reads or writes anything. Routes
  // addressed by `/expenses/:id` resolve the group from the expense row via
  // the guard's `fromExpense` option; the handlers still re-check membership
  // inside their transaction where the write happens — see
  // src/plugins/group-access.ts.

  // -- create -----------------------------------------------------------------
  //
  // Creating an expense is the write that opens a debt for every other
  // participant, so it carries its own per-user budget rather than spending the
  // caller's global allowance. The policy is a `preHandler` limit, which runs
  // after the `app.authenticate` hook above, so the bucket key is the SEP-10
  // public key from the caller's token and a shared NAT cannot pool one
  // member's budget against another's. It is its own bucket prefix, so retries
  // against the settlement routes below never draw down this allowance.
  const createLimit = rateLimited("expenseCreate");

  // Amending or deleting an expense rewrites what every other participant
  // owes, so the mutations get their own per-user budget rather than drawing
  // on the global allowance. Separate from `createLimit`: a client correcting
  // a typo must not exhaust the allowance that guards opening new
  // obligations.
  const mutateLimit = rateLimited("expenseMutate");

  app.post(
    "/groups/:id/expenses",
    {
      ...createLimit,
      preHandler: [
        app.idempotent({
          scope: "expense.create",
          required: true,
          resourceId: (req) => idParamSchema.parse(req.params).id,
          afterGuards: true,
        }),
        requireGroupRole("member", { param: "id", active: true }),
        validateRequest({ params: idParamSchema, body: createExpenseSchema }),
      ],
      schema: {
        tags: ["Expenses"],
        summary: "Create an expense in a group",
        description:
          "Records a group expense and its payment split. The payer's share is settled immediately; every other participant's share is owed. Supply `X-Idempotency-Key` to safely retry the same request.",
        params: openApiIdParams(),
        body: openApiBody(createExpenseSchema, { enforce: false }),
        response: {
          ...openApiResponse(
            { expense: openApiSchemaRef("Expense") },
            ["expense"]
          ),
          ...openApiErrorResponses(400, 401, 403, 404, 409, 429),
        },
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = req.params as { id: string };
    const body = req.body as CreateExpenseInput;
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
      computed = computeShares(body.amount, body.splitType, body.shares);
    } catch (e) {
      // The engine's errors are all client mistakes carrying a stable code;
      // the route forwards code + message so a client can branch without
      // parsing prose. An unexpected error is not a split problem — rethrow
      // it rather than disguising it as one.
      if (!isSettlementEngineError(e)) throw e;
      throw Errors.badRequest(e.code, e.message);
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

    const expense = await prisma.$transaction(async (tx) => {
      // Re-verify the caller's membership inside the atomic unit. The
      // preHandler guard authorised the request before this handler ran, so a
      // concurrent removal or archival could have landed since; re-running the
      // same check here (as the update and delete routes already do) means the
      // check and the insert either both see the membership or neither runs.
      await requireActiveMembership(groupId, auth.id, tx);

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

req.log.info({ userId: auth.id, groupId, expenseId: created.id, action: "expense.create" }, "Audit: expense created");
      await logActionTx(tx, {
        correlationId: req.id,
        actorId: auth.id,
        groupId,
        action: AuditAction.EXPENSE_CREATE,
        resourceType: "expense",
        resourceId: created.id,
        // payerUserId is client-supplied, so it is recorded as metadata; the
        // actor is always the authenticated user.
        metadata: {
          amount: body.amount,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          payerUserId,
          splitType: body.splitType,
          shareCount: computed.length,
        },
      });

      return created;
    });

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
          "Returns a paginated, filterable list of the group's expenses. Requires membership. Cursor pagination is keyset-based on (createdAt, id); `nextCursor` is null on the last page.",
        params: openApiIdParams(),
        querystring: openApiQuery({
          limit: {
            type: "string",
            description: `Page size, capped at ${GROUP_LIST_MAX_PAGE_SIZE}.`,
          },
          cursor: {
            type: "string",
            description: "Opaque continuation token from `meta.nextCursor`.",
          },
          order: { type: "string", description: "`asc` or `desc` (default)." },
          status: {
            type: "string",
            description:
              "Settlement state filter: `pending` (any share outstanding) or `settled` (every share settled). Case-insensitive.",
          },
          asset: { type: "string", description: "Asset code filter (`XLM` or `USDC`)." },
          startDate: { type: "string", description: "Inclusive ISO-8601 lower bound on `createdAt`." },
          endDate: { type: "string", description: "Inclusive ISO-8601 upper bound on `createdAt`." },
          categoryId: { type: "string", description: "Matches a description substring or an exact memo." },
          page: { type: "string", description: "Opt into offset pagination instead of the cursor." },
          includeTotal: { type: "string", description: "`true` to include a filtered total count." },
        }),
        response: {
          ...openApiResponse(
            {
              expenses: {
                type: "array",
                items: openApiSchemaRef("Expense"),
              },
              meta: { type: "object", additionalProperties: true },
              nextCursor: { type: ["string", "null"] },
            },
            ["expenses", "meta", "nextCursor"]
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

    // `meta.nextCursor` is the shared pagination contract; it is also mirrored
    // at the top level so clients written against the expense-list contract
    // (#1048) can read it without destructuring `meta`. Additive, never a
    // replacement for the existing envelope.
    return { expenses: items.map(serializeExpense), meta, nextCursor: meta.nextCursor };
  });

  // -- get one ----------------------------------------------------------------
  app.get(
    "/expenses/:id",
    {
      preHandler: requireGroupRole("member", { param: "id", fromExpense: true }),
      schema: {
        tags: ["Expenses"],
        summary: "Get an expense",
        description:
          "Returns a single expense with its payer and shares. Requires membership of the expense's group.",
        params: openApiIdParams(),
        response: {
          ...openApiResponse(
            { expense: openApiSchemaRef("Expense") },
            ["expense"]
          ),
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
      ...mutateLimit,
      preHandler: [
        requireExpensePayerOrAdmin({ param: "id", active: true }),
        validateRequest({ params: idParamSchema, body: updateExpenseSchema }),
      ],
      schema: {
        tags: ["Expenses"],
        summary: "Update an expense",
        description:
          "Updates expense metadata. Only the payer or a group admin may edit it.",
        params: openApiIdParams(),
        body: openApiBody(updateExpenseSchema, { enforce: false }),
        response: {
          ...openApiResponse(
            { expense: openApiSchemaRef("Expense") },
            ["expense"]
          ),
          ...openApiErrorResponses(400, 401, 403, 404),
        },
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = req.params as { id: string };
    const body = req.body as UpdateExpenseInput;

    // The membership/role check and the update run in one transaction: a
    // concurrent removal or demotion of `auth.id` between the check and the
    // write cannot slip an unauthorized edit through.
    const updated = await prisma.$transaction(async (tx) => {
      const expense = await tx.expense.findUnique({ where: { id } });
      if (!expense) throw Errors.notFound("Expense not found");
      const ctx = await requireActiveMembership(expense.groupId, auth.id, tx);
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
        correlationId: req.id,
        userId: auth.id,
        groupId: expense.groupId,
        action: AuditAction.EXPENSE_UPDATE,
        entityType: "expense",
        entityId: id,
        metadata: { fields: Object.keys(body) },
      });

      return result;
    });
    return { expense: serializeExpense(updated) };
  });

  // -- delete -----------------------------------------------------------------
  app.delete(
    "/expenses/:id",
    {
      ...mutateLimit,
      preHandler: [
        requireExpensePayerOrAdmin({ param: "id", active: true }),
        validateRequest({ params: idParamSchema }),
      ],
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
    const { id } = req.params as { id: string };

    // Same atomicity concern as the update route above: check and delete
    // happen in one transaction.
    await prisma.$transaction(async (tx) => {
      const found = await tx.expense.findUnique({
        where: { id },
        include: { shares: true },
      });
      if (!found) throw Errors.notFound("Expense not found");
      const ctx = await requireActiveMembership(found.groupId, auth.id, tx);
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
        correlationId: req.id,
        userId: auth.id,
        groupId: found.groupId,
        action: AuditAction.EXPENSE_DELETE,
        entityType: "expense",
        entityId: id,
        metadata: { amount: String(found.amount), assetCode: found.assetCode },
      });
    });
    return { ok: true };
  });
}
