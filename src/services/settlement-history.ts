/**
 * Filtering and pagination for a group's settlement history (issue #692).
 *
 * `GET /groups/:id/settlements` already paged, but it had no filters, so the
 * only way to answer "which of our settlements failed" or "what did we settle
 * in USDC last month" was to page the whole history and filter client-side —
 * which is the load the pagination was there to avoid in the first place.
 *
 * The query construction lives here rather than in the route so the filter
 * semantics can be asserted without an HTTP server, matching the split
 * `src/services/expenses.ts` uses for the group expense list. Pagination
 * itself is `src/lib/pagination.ts` unchanged: a `(createdAt, id)` cursor,
 * `limit + 1` rows to decide `hasMore`, and the shared `meta` shape. Filters
 * compose with the cursor rather than replacing it.
 *
 * ## Filtering by a status the database does not store
 *
 * The `settlements.status` column is internal and has accumulated values over
 * time; clients are given the small stable set in
 * `src/services/settlement-status.ts` instead. Two of those public values are
 * *derived* rather than stored — a row sitting at `pending` or `submitted`
 * past its `expiresAt` is publicly `expired` — so a filter that matched the
 * column directly would disagree with the status the same row reports when
 * read individually, which is worse than having no filter at all.
 *
 * `publicStatusFilter` is therefore written as the exact inverse of
 * `toPublicStatus`, including its clock-skew tolerance and its treatment of
 * unrecognised column values. The invariant it keeps: every row matches
 * exactly one public status, so the five filtered pages partition the history
 * with no row appearing twice and none unreachable.
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
import { CLOCK_SKEW_TOLERANCE_SECONDS, nowSeconds } from "../lib/time-bounds";
import { SETTLEMENT_STATUSES, type SettlementStatus } from "./settlement-status";

/**
 * Assets a caller may filter by.
 *
 * `Settlement.assetCode` is a free-form column, so this is an API-level
 * restriction: the filter exists to slice a history, and accepting arbitrary
 * codes would let a caller probe which codes a group has used. Matches the
 * expense list's `FILTERABLE_ASSETS` for the same reason.
 */
export const FILTERABLE_ASSETS = ["XLM", "USDC"] as const;

/**
 * Query parameters for the group settlement list. Extends the shared
 * pagination schema; the filters are additive.
 */
export const settlementListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(SETTLEMENT_STATUSES).optional(),
  asset: z.enum(FILTERABLE_ASSETS).optional(),
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

export type SettlementListQuery = z.infer<typeof settlementListQuerySchema>;

export interface SettlementListPage<T> {
  items: T[];
  meta: PageMeta & { total?: number };
}

/** Column values that mean what they say, whatever the clock reads. */
const TERMINAL_COLUMN_STATUSES = ["confirmed", "failed", "expired"] as const;

/**
 * The instant before which a recorded expiry counts as lapsed.
 *
 * Derived the same way `isIntentExpired` derives it — whole seconds, minus the
 * shared skew tolerance — so a row cannot be `expired` to this filter and
 * `submitted` to a direct read of the same settlement a millisecond later.
 */
export function expiryCutoff(now: Date = new Date()): Date {
  return new Date((nowSeconds(now) - CLOCK_SKEW_TOLERANCE_SECONDS) * 1000);
}

/**
 * Translate a public status into a condition on the stored columns.
 *
 * The inverse of `toPublicStatus`:
 *
 *  - `confirmed` / `failed` — the column says so; expiry is irrelevant.
 *  - `expired`   — the column says so, *or* a row still in flight
 *                  (`pending`/`submitted`, or any unrecognised value) whose
 *                  recorded expiry has lapsed.
 *  - `submitted` — the column says `submitted` and the expiry has not lapsed
 *                  (a null expiry is a row predating expiry tracking, which is
 *                  never treated as expired).
 *  - `awaiting_signature` — anything not in the four cases above whose expiry
 *                  has not lapsed. Expressed as `notIn` rather than
 *                  `equals: "pending"` so an unrecognised column value lands
 *                  here, exactly as `toPublicStatus`'s `default` branch
 *                  reports it: not yet signed, definitely not paid.
 */
export function publicStatusFilter(
  status: SettlementStatus,
  now: Date = new Date()
): Prisma.SettlementWhereInput {
  const cutoff = expiryCutoff(now);
  const notLapsed: Prisma.SettlementWhereInput = {
    OR: [{ expiresAt: null }, { expiresAt: { gte: cutoff } }],
  };

  switch (status) {
    case "confirmed":
      return { status: "confirmed" };
    case "failed":
      return { status: "failed" };
    case "expired":
      return {
        OR: [
          { status: "expired" },
          {
            status: { notIn: [...TERMINAL_COLUMN_STATUSES] },
            expiresAt: { lt: cutoff },
          },
        ],
      };
    case "submitted":
      return { AND: [{ status: "submitted" }, notLapsed] };
    case "awaiting_signature":
      return {
        AND: [{ status: { notIn: [...TERMINAL_COLUMN_STATUSES, "submitted"] } }, notLapsed],
      };
  }
}

/**
 * Reject a reversed range up front. Without this the query is valid but can
 * only ever return nothing, which reads to a client as "no settlements"
 * rather than "your dates are backwards".
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

/** Both bounds inclusive, matching the expense list and the audit log. */
function dateFilter(
  startDate: string | undefined,
  endDate: string | undefined
): Prisma.SettlementWhereInput {
  return {
    createdAt: {
      ...(startDate && { gte: new Date(startDate) }),
      ...(endDate && { lte: new Date(endDate) }),
    },
  };
}

/**
 * The filter conditions for a query, excluding pagination.
 *
 * Exported so the semantics can be asserted against the shape handed to
 * Prisma, without standing up a route.
 */
export function settlementFilters(
  groupId: string,
  query: Pick<SettlementListQuery, "status" | "asset" | "startDate" | "endDate">,
  now: Date = new Date()
): Prisma.SettlementWhereInput[] {
  return [
    { groupId },
    ...(query.asset ? [{ assetCode: query.asset }] : []),
    ...(query.status ? [publicStatusFilter(query.status, now)] : []),
    ...(query.startDate || query.endDate
      ? [dateFilter(query.startDate, query.endDate)]
      : []),
  ];
}

/**
 * List one page of a group's settlements.
 *
 * The caller must have authorized group access first: this function scopes by
 * `groupId` but performs no membership check of its own.
 */
export async function listGroupSettlements<T extends { createdAt: Date; id: string }>(
  groupId: string,
  query: SettlementListQuery,
  include: Prisma.SettlementInclude,
  now: Date = new Date()
): Promise<SettlementListPage<T>> {
  assertValidRange(query.startDate, query.endDate);

  const position = requireCursor(query.cursor);
  const filters = settlementFilters(groupId, query, now);
  const cursorCondition = cursorFilter(position, query.order);

  // Unfiltered requests keep the flat `{ groupId, ...cursor }` shape the route
  // has always used; only a filtered one pays for the `AND` wrapper.
  const where: Prisma.SettlementWhereInput =
    filters.length === 1
      ? { groupId, ...cursorCondition }
      : { AND: [...filters, cursorCondition] };

  const rows = (await prisma.settlement.findMany({
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
  const total = await prisma.settlement.count({
    where: filters.length === 1 ? { groupId } : { AND: filters },
  });
  return { items, meta: { ...meta, total } };
}
