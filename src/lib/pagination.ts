/**
 * The one pagination convention for every list endpoint in this API.
 *
 * ## Contract
 *
 * Query parameters (all optional, all validated with Zod):
 *
 *   limit  — page size. Integer in [1, MAX_PAGE_SIZE]. Default DEFAULT_PAGE_SIZE.
 *            Anything outside the range is a `VALIDATION_ERROR`, not a silent
 *            clamp: a client asking for 5000 rows has misunderstood the
 *            contract, and quietly handing back 100 would hide that.
 *   cursor — opaque continuation token from a previous response's
 *            `meta.nextCursor`. Malformed values are an `INVALID_CURSOR` error.
 *   order  — `desc` (newest first, the default) or `asc`.
 *
 * Response metadata is identical on every list endpoint:
 *
 *   { items…, meta: { nextCursor: string | null, hasMore: boolean, limit: number, order: "asc" | "desc" } }
 *
 * ## Why cursors
 *
 * Offset pagination drifts: rows inserted while a client is paging cause
 * duplicates and gaps, and a large offset makes the database walk everything it
 * skips. Cursors are keyed on the same tuple the query is ordered by, so a page
 * boundary is stable regardless of what was written in between, and the query
 * stays an indexed range scan.
 *
 * ## Deterministic ordering
 *
 * Ordering is always the pair `(createdAt, id)`, never `createdAt` alone.
 * Timestamps tie routinely — bulk inserts, seeded data, anything written inside
 * one transaction — and a tie under `ORDER BY createdAt` alone has no defined
 * resolution, so the same row can appear on two consecutive pages or on
 * neither. `id` is unique, so the pair is a total order, which is exactly what
 * makes the cursor comparison below sound.
 *
 * ## Bounded reads
 *
 * A page fetches `limit + 1` rows: `limit` to return, one to detect whether
 * another page exists. No endpoint loads a full result set to count or slice it,
 * so a large table costs the same as a small one.
 *
 * ## Cursors and access control
 *
 * A cursor is base64url, not encrypted — it is opaque to discourage clients
 * from parsing it, not to hide anything. It deliberately contains **only**
 * ordering coordinates (a timestamp and a row id) and never a group id, user
 * id, or permission. Every list query independently applies its own `where`
 * scope and its own membership check, so a cursor lifted from one resource and
 * replayed against another can only shift where a page *starts* inside data the
 * caller may already read. It can never widen that scope, skip a membership
 * check, or confirm that the row it names exists.
 */
import { z } from "zod";
import { Errors } from "../errors";

/** Rows returned when a client does not ask for a specific page size. */
export const DEFAULT_PAGE_SIZE = 50;

/**
 * Hard ceiling on rows per page. Bounds the work a single request can ask the
 * database and the JSON serializer to do; clients needing more must page.
 */
export const MAX_PAGE_SIZE = 100;

export type SortOrder = "asc" | "desc";

/**
 * The shared query schema. Routes with no extra parameters parse `req.query`
 * with this directly; routes with their own filters extend it with `.extend()`
 * so the pagination contract stays identical across all of them.
 */
export const paginationQuerySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Pagination metadata attached to every list response. */
export interface PageMeta {
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
  order: SortOrder;
}

/** Ordering coordinates a cursor carries — nothing else belongs in one. */
export interface CursorPosition {
  createdAt: Date;
  id: string;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.getTime()}_${id}`).toString("base64url");
}

export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    // Split on the *first* separator only: ids may legitimately contain an
    // underscore (a prefixed id like `expense_9`), and splitting on every one
    // would reject a cursor this module itself produced.
    const separator = decoded.indexOf("_");
    if (separator <= 0) return null;

    const timestamp = Number(decoded.slice(0, separator));
    if (!Number.isFinite(timestamp)) return null;

    const id = decoded.slice(separator + 1);
    if (!id) return null;

    const createdAt = new Date(timestamp);
    if (Number.isNaN(createdAt.getTime())) return null;

    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Decode a cursor or raise the standard error.
 *
 * Rejecting a malformed cursor rather than ignoring it matters: silently
 * treating garbage as "start from the beginning" would hand a client page one
 * when it believed it was on page nine, and would quietly hide a client bug.
 */
export function requireCursor(cursor: string | undefined): CursorPosition | null {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor);
  if (!decoded) {
    throw Errors.badRequest("invalid_cursor", "The provided cursor is invalid");
  }
  return decoded;
}

/**
 * Prisma `orderBy` for the deterministic `(createdAt, id)` ordering. Both keys
 * always move in the same direction, so the cursor comparison below matches the
 * sort exactly.
 */
export function cursorOrderBy(order: SortOrder = "desc") {
  return [{ createdAt: order }, { id: order }];
}

/**
 * Prisma `where` fragment that resumes strictly after a cursor position.
 *
 * This is the row-value comparison `(createdAt, id) < (cursor.createdAt,
 * cursor.id)` written the way Prisma expresses it: either the timestamp is
 * strictly past the cursor's, or it ties and the id breaks the tie. Because the
 * comparison uses the same total order as `cursorOrderBy`, a row can never
 * appear on two pages or be skipped between them — including when a batch of
 * rows shares one timestamp.
 *
 * Returns `{}` for no cursor, so it can always be spread into a `where`.
 */
export function cursorFilter(
  position: CursorPosition | null,
  order: SortOrder = "desc"
): Record<string, unknown> {
  if (!position) return {};

  const comparator = order === "desc" ? "lt" : "gt";
  return {
    OR: [
      { createdAt: { [comparator]: position.createdAt } },
      {
        createdAt: position.createdAt,
        id: { [comparator]: position.id },
      },
    ],
  };
}

/** How many rows to fetch for a page: the page itself, plus one lookahead row. */
export function takeForPage(limit: number): number {
  return limit + 1;
}

/**
 * Split a `limit + 1` row fetch into the page and its metadata.
 *
 * `rows` must be ordered by `cursorOrderBy(order)` and fetched with
 * `takeForPage(limit)`; the extra row is what makes `hasMore` exact rather than
 * a guess, with no second count query.
 */
export function buildPage<T extends CursorPosition>(
  rows: T[],
  limit: number,
  order: SortOrder = "desc"
): { items: T[]; meta: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    meta: {
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
      hasMore,
      limit,
      order,
    },
  };
}
