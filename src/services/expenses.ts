/**
 * Expense creation and listing: persistence, query construction, filtering,
 * and pagination.
 *
 * The route stays thin — it authorizes, parses, and serializes. Everything
 * about *which* rows a page contains lives here so the filter semantics have
 * one home and can be tested without an HTTP server. The multi-table write
 * behind expense creation lives here too, so its transaction boundary has a
 * single home.
 *
 * Pagination follows `src/lib/pagination.ts` unchanged: a `(createdAt, id)`
 * cursor, `limit + 1` rows to detect a further page, and the shared `meta`
 * shape. Filters compose with the cursor rather than replacing it, so a
 * filtered scan pages exactly like an unfiltered one.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
  type PageMeta,
} from "../lib/pagination";
import { auditTx } from "./audit";

/**
 * Settlement state of an expense, as clients express it.
 *
 * `Expense` has no status column: settlement is tracked per participant on
 * `ExpenseShare.status` (lowercase `"pending"` / `"settled"`). An expense is
 * therefore SETTLED only when every share is settled, and PENDING while any
 * share is outstanding — the two are exact complements, so a row always
 * matches exactly one of them and neither page can double-count.
 */
export const EXPENSE_STATUSES = ["PENDING", "SETTLED"] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

/** The per-share value stored in the database for a settled share. */
const SHARE_SETTLED = "settled";

/**
 * Assets a caller may filter by.
 *
 * `Expense.assetCode` is a free-form string in the schema, so this list is an
 * API-level restriction rather than a database constraint. It is deliberately
 * narrow: the filter exists to slice a history, and accepting arbitrary codes
 * would let a caller probe which asset codes a group has used.
 */
export const FILTERABLE_ASSETS = ["XLM", "USDC"] as const;

/**
 * Query parameters for the group expense list.
 *
 * Extends the shared pagination schema so cursor/limit/order behave
 * identically to every other paginated route; the filters are additive.
 */
export const expenseListQuerySchema = paginationQuerySchema.extend({
  asset: z.enum(FILTERABLE_ASSETS).optional(),
  status: z.enum(EXPENSE_STATUSES).optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  /**
   * Opt-in total count. Counting a filtered set is a second query over every
   * matching row, which the pagination contract deliberately avoids paying on
   * every request — so clients that need a total ask for it explicitly.
   */
  includeTotal: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .optional(),
});

export type ExpenseListQuery = z.infer<typeof expenseListQuerySchema>;

/** Page of expenses plus its metadata, with `total` only when requested. */
export interface ExpenseListPage<T> {
  items: T[];
  meta: PageMeta & { total?: number };
}

/**
 * Translate a status filter into a share-level condition.
 *
 * `every` on an empty relation is vacuously true in Prisma, so an expense with
 * no shares would match SETTLED. Requiring at least one share via `some` keeps
 * a share-less row out of both pages rather than reporting it as settled.
 */
export function expenseStatusFilter(status: string): Prisma.ExpenseWhereInput {
  if (status.toUpperCase() === "SETTLED") {
    return {
      shares: {
        some: {},
        every: { status: SHARE_SETTLED },
      },
    };
  }
  return {
    shares: { some: { status: { not: SHARE_SETTLED } } },
  };
}

/**
 * Build the `createdAt` range from the validated ISO timestamps.
 *
 * Both bounds are inclusive, matching the audit-log route's convention.
 */
function dateFilter(
  startDate: string | undefined,
  endDate: string | undefined
): Prisma.ExpenseWhereInput {
  if (!startDate && !endDate) return {};
  return {
    createdAt: {
      ...(startDate && { gte: new Date(startDate) }),
      ...(endDate && { lte: new Date(endDate) }),
    },
  };
}

/**
 * Reject a reversed range up front.
 *
 * Without this the query is valid but can only ever return nothing, which
 * reads to a client as "no expenses" rather than "your dates are backwards".
 */
export function assertValidRange(
  startDate: string | undefined,
  endDate: string | undefined
): void {
  if (!startDate || !endDate) return;
  if (new Date(startDate) > new Date(endDate)) {
    throw Errors.badRequest("invalid_range", "startDate must not be after endDate");
  }
}

/**
 * The filter conditions for a query, excluding pagination.
 *
 * Exported so tests can assert filter semantics directly against the shape
 * handed to Prisma, without standing up a route.
 */
export function expenseFilters(
  groupId: string,
  query: Pick<ExpenseListQuery, "asset" | "status" | "startDate" | "endDate">
): Prisma.ExpenseWhereInput[] {
  return [
    { groupId },
    ...(query.asset ? [{ assetCode: query.asset }] : []),
    ...(query.status ? [expenseStatusFilter(query.status)] : []),
    ...(query.startDate || query.endDate
      ? [dateFilter(query.startDate, query.endDate)]
      : []),
  ];
}

/**
 * List one page of a group's expenses.
 *
 * The caller must have authorized group access first: this function scopes by
 * `groupId` but performs no membership check of its own.
 */
export async function listGroupExpenses<T extends { createdAt: Date; id: string }>(
  groupId: string,
  query: ExpenseListQuery,
  include: Prisma.ExpenseInclude
): Promise<ExpenseListPage<T>> {
  assertValidRange(query.startDate, query.endDate);

  const position = requireCursor(query.cursor);
  const filters = expenseFilters(groupId, query);

  // With no filters beyond the group scope, the query keeps the flat shape it
  // has always had (`{ groupId, ...cursor }`). Only a filtered request pays for
  // the `AND` wrapper. Either way the cursor condition stays separate from the
  // filters, so paging never widens the result set: a page is always a window
  // over the filtered rows.
  const cursorCondition = cursorFilter(position, query.order);
  const where: Prisma.ExpenseWhereInput =
    filters.length === 1
      ? { groupId, ...cursorCondition }
      : { AND: [...filters, cursorCondition] };

  const rows = (await prisma.expense.findMany({
    where,
    include,
    orderBy: cursorOrderBy(query.order),
    take: takeForPage(query.limit),
  })) as unknown as T[];

  const { items, meta } = buildPage(rows, query.limit, query.order);

  if (!query.includeTotal) {
    return { items, meta };
  }

  // Counted over the filters alone — the cursor describes where this page
  // starts, so including it would count only the remainder of the scan.
  const total = await prisma.expense.count({
    where: filters.length === 1 ? { groupId } : { AND: filters },
  });
  return { items, meta: { ...meta, total } };
}

// -- creation ---------------------------------------------------------------

/** One participant's computed, validated share, ready to be persisted. */
export interface ExpenseShareDraft {
  userId: string;
  shareAmount: string;
}

/**
 * Everything the persistence step needs. The caller has already validated
 * membership, the payer, the split arithmetic, and the asset — this payload
 * describes rows to write, not a request to interpret.
 */
export interface CreateGroupExpenseParams {
  groupId: string;
  /** Whose expense it is; their own share is persisted as settled. */
  payerUserId: string;
  /** The authenticated caller, recorded as the audit actor. */
  actorUserId: string;
  title: string;
  description?: string | null;
  amount: string;
  assetCode: string;
  assetIssuer?: string | null;
  splitType: string;
  memo: string;
  receiptUrl?: string | null;
  shares: ExpenseShareDraft[];
}

/**
 * Persist a group expense, its participant splits, and its `expense.create`
 * audit entry in ONE Prisma transaction.
 *
 * The three writes span three tables and must land together. Without a shared
 * transaction, a split that fails after the expense row is inserted leaves an
 * expense with no shares — invisible to settlement but visible in the history
 * — and a successful audit write can describe a row that was never committed.
 * Inside `prisma.$transaction`, any throw (a constraint violation on a split,
 * a failing audit write, an abrupt connection drop) rolls back every write in
 * the unit, so the database either holds all three records or none of them.
 *
 * Validation and authorization stay with the caller; this function only
 * persists what has already been proven valid.
 */
export async function createGroupExpense<
  T extends { createdAt: Date; id: string }
>(params: CreateGroupExpenseParams, include: Prisma.ExpenseInclude): Promise<T> {
  const created = await prisma.$transaction(async (tx) => {
    const expense = await tx.expense.create({
      data: {
        groupId: params.groupId,
        payerUserId: params.payerUserId,
        title: params.title,
        description: params.description ?? null,
        amount: params.amount,
        assetCode: params.assetCode,
        assetIssuer: params.assetIssuer ?? null,
        splitType: params.splitType,
        memo: params.memo,
        receiptUrl: params.receiptUrl ?? null,
        shares: {
          create: params.shares.map((share) => ({
            userId: share.userId,
            shareAmount: share.shareAmount,
            // The payer's own share is settled the moment the expense exists.
            status: share.userId === params.payerUserId ? "settled" : "pending",
          })),
        },
      },
      include,
    });

    // Same transaction: the audit entry exists if and only if the expense it
    // documents was committed. `auditTx` deliberately does not swallow errors.
    await auditTx(tx, {
      userId: params.actorUserId,
      groupId: params.groupId,
      action: "expense.create",
      entityType: "expense",
      entityId: expense.id,
      metadata: { amount: params.amount, assetCode: params.assetCode },
    });

    return expense;
  });

  return created as unknown as T;
}
