/**
 * Shared Zod schemas — issue #440.
 *
 * The canonical pagination query schema lives in `src/lib/pagination.ts`,
 * which every list route already parses `req.query` with, so there is exactly
 * one source of truth for the pagination contract (defaults, bounds, error
 * semantics). Following the same pattern as `src/schemas/sep24.ts`, this
 * module re-exports it under the location the issue names so callers have a
 * single import point — it must not be duplicated here, or the two copies
 * would drift.
 */
export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  type PaginationQuery,
  type PageMeta,
  type SortOrder,
} from "../lib/pagination";
