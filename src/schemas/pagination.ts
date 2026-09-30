/**
 * Shared Zod schema for pagination query parameters — issue #410.
 *
 * Every list endpoint parses `req.query` with the canonical schema in
 * `src/lib/pagination.ts`, so that module stays the single source of truth for
 * the pagination contract (defaults, bounds, error semantics). This module is
 * the import point the issue names, re-exporting the same objects rather than
 * redefining them so the two paths can never drift — the same precedent set by
 * `src/schemas/common.ts`.
 *
 * ## Contract
 *
 * `limit`  — page size. Integer in [1, MAX_PAGE_SIZE]. Default
 *            DEFAULT_PAGE_SIZE. Out-of-range input is a `VALIDATION_ERROR`
 *            rather than a silent clamp, so a client asking for too many rows
 *            learns its request was rejected instead of receiving a smaller
 *            page than it believes it asked for.
 * `cursor` — opaque continuation token from a previous `meta.nextCursor`.
 * `order`  — `desc` (newest first, the default) or `asc`.
 *
 * The schema is `.strict()`: unknown parameters are rejected. In particular
 * there is no `offset`/`page`, because offset paging drifts under concurrent
 * writes and would describe a boundary the cursor response does not honour —
 * `?page=3` on a cursor endpoint is a client bug, not a silently ignored key.
 */
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  type PaginationQuery,
  type PageMeta,
  type SortOrder,
} from "../lib/pagination";
