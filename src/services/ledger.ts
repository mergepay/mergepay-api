/**
 * Filtering for the group ledger — the combined expense / settlement /
 * treasury history (issue #692).
 *
 * `GET /groups/:id/ledger` interleaves three tables into one time-ordered
 * feed. It paged correctly, but every request read all three tables whatever
 * the caller wanted: a client rendering "recent expenses" still paid for a
 * settlement scan and a treasury scan, and then threw both away.
 *
 * Two filters fix that, and both are cheap because they push into the queries
 * rather than filtering the merged page:
 *
 *  - `type` selects which tables are read at all. A `type=expense` request
 *    issues one query instead of three.
 *  - `startDate` / `endDate` bound `createdAt` on each table, so a request for
 *    last month's activity is an indexed range scan rather than a scan of
 *    everything newer than the cursor.
 *
 * Filtering the *merged* page instead would have been the trap: each table is
 * read with its own `limit + 1` window, so dropping rows after the merge would
 * silently shrink pages — a page of 50 could come back with 3 — and `hasMore`
 * would describe the unfiltered scan. Pushing the filters into each query
 * keeps every page full and `hasMore` exact.
 */
import { z } from "zod";
import { Errors } from "../errors";
import { paginationQuerySchema } from "../lib/pagination";

/** The three kinds of entry the ledger interleaves. */
export const LEDGER_ENTRY_TYPES = ["expense", "settlement", "treasury"] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

/**
 * Query parameters for the ledger. Extends the shared pagination schema, so
 * cursor/limit/order are identical to every other paginated route.
 *
 * `type` accepts one kind or a comma-separated list (`type=expense,settlement`)
 * — a single parameter rather than three booleans, so "everything" stays the
 * default and an unknown kind is a validation error rather than a silently
 * empty feed.
 */
export const ledgerQuerySchema = paginationQuerySchema.extend({
  type: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const requested = value.split(",").map((part) => part.trim());
      const unknown = requested.filter(
        (part) => !LEDGER_ENTRY_TYPES.includes(part as LedgerEntryType)
      );
      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `type must be one or more of: ${LEDGER_ENTRY_TYPES.join(", ")}`,
        });
        return z.NEVER;
      }
      // De-duplicated: `type=expense,expense` asks for one kind, and a
      // repeated kind must not read the same table twice.
      return [...new Set(requested as LedgerEntryType[])];
    }),
  startDate: z.string().datetime({ offset: true }).optional(),
  endDate: z.string().datetime({ offset: true }).optional(),
});

export type LedgerQuery = z.infer<typeof ledgerQuerySchema>;

/**
 * Reject a reversed range up front, so an impossible window reads as a client
 * mistake rather than as an empty ledger.
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

/** Whether a given entry kind is part of this request. */
export function includesType(
  query: Pick<LedgerQuery, "type">,
  type: LedgerEntryType
): boolean {
  return query.type === undefined || query.type.includes(type);
}

/** A `createdAt` range, in the shape all three models share. */
export interface CreatedAtRange {
  createdAt?: { gte?: Date; lte?: Date };
}

/**
 * The `createdAt` bound shared by all three queries, as a spreadable
 * fragment. Both bounds inclusive, matching the expense and settlement lists.
 *
 * Typed as the structural fragment rather than one model's `WhereInput`,
 * because the same object is spread into an expense, a settlement, and a
 * treasury-transaction query — all three of which accept it.
 *
 * Returns `{}` when no range was requested, so it can always be spread into a
 * `where` — and so an unfiltered ledger request produces exactly the query it
 * produced before this filter existed.
 */
export function ledgerDateFilter(
  query: Pick<LedgerQuery, "startDate" | "endDate">
): CreatedAtRange {
  if (!query.startDate && !query.endDate) return {};
  return {
    createdAt: {
      ...(query.startDate && { gte: new Date(query.startDate) }),
      ...(query.endDate && { lte: new Date(query.endDate) }),
    },
  };
}
