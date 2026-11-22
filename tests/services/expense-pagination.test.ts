import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Unit tests for group expense pagination and filtering (Issue #912).
 *
 * Validates:
 * - Zod query schema parsing for limit, cursor, order, asset, status, and date range
 * - Date range inversion rejection (startDate > endDate)
 * - Expense status filter construction (PENDING / SETTLED)
 * - Expense filter composition with asset, status, and date filters
 * - Cursor encoding / decoding round-trip
 */

import {
  expenseListQuerySchema,
  expenseStatusFilter,
  expenseFilters,
  assertValidRange,
  EXPENSE_STATUSES,
  FILTERABLE_ASSETS,
} from "../../src/services/expenses";
import {
  encodeCursor,
  decodeCursor,
  buildPage,
  DEFAULT_PAGE_SIZE,
  GROUP_LIST_MAX_PAGE_SIZE,
} from "../../src/lib/pagination";

describe("Group Expense Pagination & Filtering (#912)", () => {
  describe("expenseListQuerySchema", () => {
    it("accepts a request with no parameters and fills defaults", () => {
      const result = expenseListQuerySchema.parse({});
      expect(result.limit).toBe(DEFAULT_PAGE_SIZE);
      expect(result.order).toBe("desc");
      expect(result.asset).toBeUndefined();
      expect(result.status).toBeUndefined();
      expect(result.cursor).toBeUndefined();
    });

    it("accepts valid limit, order, asset, and status parameters", () => {
      const result = expenseListQuerySchema.parse({
        limit: 25,
        order: "asc",
        asset: "XLM",
        status: "PENDING",
      });
      expect(result.limit).toBe(25);
      expect(result.order).toBe("asc");
      expect(result.asset).toBe("XLM");
      expect(result.status).toBe("PENDING");
    });

    it("accepts USDC as a filterable asset", () => {
      const result = expenseListQuerySchema.parse({ asset: "USDC" });
      expect(result.asset).toBe("USDC");
    });

    it("accepts SETTLED status filter", () => {
      const result = expenseListQuerySchema.parse({ status: "SETTLED" });
      expect(result.status).toBe("SETTLED");
    });

    it("accepts valid ISO datetime strings for startDate and endDate", () => {
      const result = expenseListQuerySchema.parse({
        startDate: "2026-01-01T00:00:00+00:00",
        endDate: "2026-12-31T23:59:59+00:00",
      });
      expect(result.startDate).toBe("2026-01-01T00:00:00+00:00");
      expect(result.endDate).toBe("2026-12-31T23:59:59+00:00");
    });

    it("rejects limit exceeding the group-list maximum", () => {
      expect(() =>
        expenseListQuerySchema.parse({ limit: GROUP_LIST_MAX_PAGE_SIZE + 1 })
      ).toThrow();
    });

    it("rejects limit below 1", () => {
      expect(() => expenseListQuerySchema.parse({ limit: 0 })).toThrow();
    });

    it("rejects unknown query parameters (strict mode)", () => {
      expect(() =>
        expenseListQuerySchema.parse({ unknownField: "bad" })
      ).toThrow();
    });

    it("accepts valid page and categoryId query parameters (#800)", () => {
      const result = expenseListQuerySchema.parse({
        page: 2,
        categoryId: "travel_meals",
      });
      expect(result.page).toBe(2);
      expect(result.categoryId).toBe("travel_meals");
    });

    it("rejects invalid page number below 1", () => {
      expect(() =>
        expenseListQuerySchema.parse({ page: 0 })
      ).toThrow();
    });

    it("accepts includeTotal as true or 'true'", () => {
      const boolResult = expenseListQuerySchema.parse({ includeTotal: true });
      expect(boolResult.includeTotal).toBe(true);

      const strResult = expenseListQuerySchema.parse({ includeTotal: "true" });
      expect(strResult.includeTotal).toBe(true);

      const falseResult = expenseListQuerySchema.parse({ includeTotal: "false" });
      expect(falseResult.includeTotal).toBe(false);
    });
  });

  describe("assertValidRange", () => {
    it("passes when startDate is before endDate", () => {
      expect(() =>
        assertValidRange("2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z")
      ).not.toThrow();
    });

    it("passes when only one bound is provided", () => {
      expect(() => assertValidRange("2026-01-01T00:00:00Z", undefined)).not.toThrow();
      expect(() => assertValidRange(undefined, "2026-12-31T23:59:59Z")).not.toThrow();
    });

    it("passes when neither bound is provided", () => {
      expect(() => assertValidRange(undefined, undefined)).not.toThrow();
    });

    it("rejects a reversed date range (startDate > endDate)", () => {
      expect(() =>
        assertValidRange("2026-12-31T23:59:59Z", "2026-01-01T00:00:00Z")
      ).toThrow(/startDate must not be after endDate/);
    });
  });

  describe("expenseStatusFilter", () => {
    it("builds a SETTLED filter requiring every share to be settled", () => {
      const filter = expenseStatusFilter("SETTLED");
      expect(filter).toEqual({
        shares: {
          some: {},
          every: { status: "settled" },
        },
      });
    });

    it("builds a PENDING filter matching any unsettled share", () => {
      const filter = expenseStatusFilter("PENDING");
      expect(filter).toEqual({
        shares: { some: { status: { not: "settled" } } },
      });
    });

    it("treats status case-insensitively for SETTLED", () => {
      const filter = expenseStatusFilter("settled");
      expect(filter).toEqual({
        shares: {
          some: {},
          every: { status: "settled" },
        },
      });
    });
  });

  describe("expenseFilters", () => {
    it("returns only the groupId filter when no extra filters are given", () => {
      const filters = expenseFilters("group-1", {});
      expect(filters).toEqual([{ groupId: "group-1" }]);
    });

    it("adds asset filter when asset is provided", () => {
      const filters = expenseFilters("group-1", { asset: "XLM" });
      expect(filters).toContainEqual({ assetCode: "XLM" });
    });

    it("adds status filter when status is provided", () => {
      const filters = expenseFilters("group-1", { status: "PENDING" });
      expect(filters.length).toBe(2);
    });

    it("adds date filters when startDate and endDate are provided", () => {
      const filters = expenseFilters("group-1", {
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-12-31T23:59:59Z",
      });
      expect(filters.length).toBe(2); // groupId + dateFilter
    });

    it("composes all filters together", () => {
      const filters = expenseFilters("group-1", {
        asset: "USDC",
        status: "SETTLED",
        startDate: "2026-01-01T00:00:00Z",
        endDate: "2026-06-30T23:59:59Z",
      });
      expect(filters.length).toBe(4); // groupId + asset + status + date
    });
  });

  describe("Cursor pagination utilities", () => {
    it("encodeCursor and decodeCursor round-trip correctly", () => {
      const date = new Date("2026-06-15T12:00:00Z");
      const id = "expense_42";
      const cursor = encodeCursor(date, id);

      const decoded = decodeCursor(cursor);
      expect(decoded).not.toBeNull();
      expect(decoded!.createdAt.getTime()).toBe(date.getTime());
      expect(decoded!.id).toBe(id);
    });

    it("decodeCursor returns null for malformed cursors", () => {
      expect(decodeCursor("totally-invalid")).toBeNull();
      expect(decodeCursor("")).toBeNull();
    });

    it("buildPage slices rows and sets hasMore correctly", () => {
      const now = new Date();
      const rows = Array.from({ length: 6 }, (_, i) => ({
        id: `row-${i}`,
        createdAt: new Date(now.getTime() - i * 1000),
      }));

      const page = buildPage(rows, 5, "desc");
      expect(page.items).toHaveLength(5);
      expect(page.meta.hasMore).toBe(true);
      expect(page.meta.nextCursor).toBeTruthy();
      expect(page.meta.limit).toBe(5);
      expect(page.meta.order).toBe("desc");
    });

    it("buildPage returns hasMore=false when rows <= limit", () => {
      const rows = [
        { id: "only-one", createdAt: new Date() },
      ];
      const page = buildPage(rows, 5, "desc");
      expect(page.items).toHaveLength(1);
      expect(page.meta.hasMore).toBe(false);
      expect(page.meta.nextCursor).toBeNull();
    });
  });

  describe("Constants", () => {
    it("EXPENSE_STATUSES contains PENDING and SETTLED", () => {
      expect(EXPENSE_STATUSES).toContain("PENDING");
      expect(EXPENSE_STATUSES).toContain("SETTLED");
    });

    it("FILTERABLE_ASSETS contains XLM and USDC", () => {
      expect(FILTERABLE_ASSETS).toContain("XLM");
      expect(FILTERABLE_ASSETS).toContain("USDC");
    });
  });
});
