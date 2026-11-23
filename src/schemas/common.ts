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
import { z } from "zod";

export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
  type PaginationQuery,
  type PageMeta,
  type SortOrder,
} from "../lib/pagination";

/** Query booleans: `false` is a real value, so `z.coerce.boolean()` is wrong. */
export const booleanQuerySchema = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

/** Bounded identifier used by filter query parameters that address a row. */
export const identifierQuerySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);

/** Inclusive `createdAt` bounds shared by every list endpoint that filters by date. */
export const dateRangeQueryShape = {
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
};

export function dateRangeWhere(range: {
  startDate?: string;
  endDate?: string;
}): { gte?: Date; lte?: Date } | undefined {
  if (!range.startDate && !range.endDate) return undefined;
  return {
    ...(range.startDate && { gte: new Date(range.startDate) }),
    ...(range.endDate && { lte: new Date(range.endDate) }),
  };
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function mergeWhere(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const merged = { ...target };
  for (const [key, value] of Object.entries(source)) {
    merged[key] =
      isPlainObject(merged[key]) && isPlainObject(value)
        ? mergeWhere(merged[key], value)
        : value;
  }
  return merged;
}

export function composeWhere(
  filters: Record<string, unknown>[],
  cursorScope: Record<string, unknown>,
  _conflictKeys: readonly string[] = []
): any {
  return [...filters, cursorScope].reduce<Record<string, any>>(
    (where, source) => mergeWhere(where, source as Record<string, any>),
    {}
  );
}
