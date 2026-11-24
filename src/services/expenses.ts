/**
 * Expense listing: query construction, filtering, and pagination.
 *
 * The route stays thin — it authorizes, parses, and serializes. Everything
 * about *which* rows a page contains lives here so the filter semantics have
 * one home and can be tested without an HTTP server.
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
  DEFAULT_PAGE_SIZE,
  GROUP_LIST_MAX_PAGE_SIZE,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
  type PageMeta,
} from "../lib/pagination";

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

/**
 * A status filter that accepts the canonical upper-case value or any casing the
 * caller sends (`?status=pending`). The API documents upper case, but a filter
 * that silently rejected `pending` while `PENDING` worked would be a trap — and
 * an unrecognized value still fails validation with a 400 rather than returning
 * an empty page.
 */
const expenseStatusFilterSchema = z
  .string()
  .transform((value) => value.toUpperCase())
  .pipe(z.enum(EXPENSE_STATUSES));

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
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(GROUP_LIST_MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  asset: z.enum(FILTERABLE_ASSETS).optional(),
  status: expenseStatusFilterSchema.optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  page: z.coerce.number().int().min(1).optional(),
  categoryId: z.string().min(1).max(64).optional(),
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
  meta: PageMeta & {
    total?: number;
    page?: number;
    totalPages?: number;
  };
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
  query: Pick<ExpenseListQuery, "asset" | "status" | "startDate" | "endDate" | "categoryId">
): Prisma.ExpenseWhereInput[] {
  return [
    { groupId },
    ...(query.asset ? [{ assetCode: query.asset }] : []),
    ...(query.status ? [expenseStatusFilter(query.status)] : []),
    ...(query.startDate || query.endDate
      ? [dateFilter(query.startDate, query.endDate)]
      : []),
    ...(query.categoryId
      ? [
          {
            OR: [
              { description: { contains: query.categoryId, mode: "insensitive" as Prisma.QueryMode } },
              { memo: { equals: query.categoryId } },
            ],
          },
        ]
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

  const filters = expenseFilters(groupId, query);
  const whereFilters: Prisma.ExpenseWhereInput =
    filters.length === 1 ? { groupId } : { AND: filters };

  // Offset page-based pagination
  if (query.page !== undefined) {
    const page = query.page;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      prisma.expense.findMany({
        where: whereFilters,
        include,
        orderBy: cursorOrderBy(query.order),
        skip,
        take: limit,
      }),
      prisma.expense.count({
        where: whereFilters,
      }),
    ]);

    const totalPages = Math.ceil(total / limit);
    return {
      items: rows as unknown as T[],
      meta: {
        page,
        totalPages,
        total,
        limit,
        hasMore: page < totalPages,
        nextCursor: null,
        order: query.order,
      },
    };
  }

  const position = requireCursor(query.cursor);

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
    where: whereFilters,
  });
  return { items, meta: { ...meta, total } };
}

/**
 * Dedicated schema for group expense history with pagination and filtering.
 */
export const groupExpenseHistorySchema = paginationQuerySchema.extend({
  asset: z.enum(FILTERABLE_ASSETS).optional(),
  assetCode: z.string().optional(),
  status: expenseStatusFilterSchema.optional(),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  includeTotal: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .transform((value) => value === true || value === "true")
    .optional(),
});

export type GroupExpenseHistoryQuery = z.infer<typeof groupExpenseHistorySchema>;

/**
 * List group expense history with cursor or offset-based pagination and filtering.
 */
export async function listGroupExpenseHistory<T extends { createdAt: Date; id: string }>(
  groupId: string,
  query: GroupExpenseHistoryQuery,
  include: Prisma.ExpenseInclude
): Promise<ExpenseListPage<T>> {
  const start = query.startDate ?? query.fromDate;
  const end = query.endDate ?? query.toDate;
  assertValidRange(start, end);

  const normalizedAsset = (query.asset ?? (query.assetCode ? (query.assetCode as "XLM" | "USDC") : undefined));
  const filters = expenseFilters(groupId, {
    asset: normalizedAsset,
    status: query.status,
    startDate: start,
    endDate: end,
  });

  const position = requireCursor(query.cursor);
  const cursorCondition = cursorFilter(position, query.order);
  const where: Prisma.ExpenseWhereInput =
    filters.length === 1
      ? { groupId, ...cursorCondition }
      : { AND: [...filters, cursorCondition] };

  const takeCount = takeForPage(query.limit);
  const skipCount = query.offset ?? undefined;

  const rows = (await prisma.expense.findMany({
    where,
    include,
    orderBy: cursorOrderBy(query.order),
    take: takeCount,
    skip: skipCount,
  })) as unknown as T[];

  const { items, meta } = buildPage(rows, query.limit, query.order);

  const total = query.includeTotal
    ? await prisma.expense.count({
        where: filters.length === 1 ? { groupId } : { AND: filters },
      })
    : undefined;

  return {
    items,
    meta: {
      ...meta,
      ...(total !== undefined ? { total } : {}),
    },
  };
}

export {
  expensePaymentIntent,
  validateExpenseXdr,
  type ExpenseIntentRecord,
} from "./expense-xdr";

