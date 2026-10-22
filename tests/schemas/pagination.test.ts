import { describe, it, expect } from "vitest";
import { paginationQuerySchema } from "../../src/schemas/pagination";

/**
 * Unit tests for the page-based query schema introduced by issue #422.
 */
describe("paginationQuerySchema", () => {
  it("provides page-based defaults and coerces query parameters", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: 20, page: 1 });
    expect(paginationQuerySchema.parse({ limit: "25", page: "3" })).toEqual({
      limit: 25,
      page: 3,
    });
    expect(paginationQuerySchema.parse({ limit: 25, page: 3 })).toEqual({
      limit: 25,
      page: 3,
    });
  });

  it("accepts the boundary limit and page values", () => {
    expect(paginationQuerySchema.parse({ limit: 1 }).limit).toBe(1);
    expect(paginationQuerySchema.parse({ limit: "1" }).limit).toBe(1);
    expect(paginationQuerySchema.parse({ limit: 100 }).limit).toBe(100);
    expect(paginationQuerySchema.parse({ limit: "100" }).limit).toBe(100);
    expect(paginationQuerySchema.parse({ page: 1 }).page).toBe(1);
    expect(paginationQuerySchema.parse({ page: "3" }).page).toBe(3);
  });

  it("rejects limits or pages outside their valid ranges", () => {
    for (const limit of ["0", "101", "1.5", "many", ""]) {
      expect(() => paginationQuerySchema.parse({ limit })).toThrow();
    }
    for (const page of ["0", "-1", "1.5", "many", ""]) {
      expect(() => paginationQuerySchema.parse({ page })).toThrow();
    }
  });

  it("rejects non-object input", () => {
    expect(() => paginationQuerySchema.parse(null)).toThrow();
    expect(() => paginationQuerySchema.parse("limit=10")).toThrow();
    expect(() => paginationQuerySchema.parse([1, 2])).toThrow();
  });
});
