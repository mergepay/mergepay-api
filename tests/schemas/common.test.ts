import { describe, it, expect } from "vitest";
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginationQuerySchema,
} from "../../src/schemas/common";

/**
 * Unit tests for the shared pagination query schema (issue #440).
 *
 * The canonical implementation lives in src/lib/pagination.ts; these tests
 * exercise it through the `src/schemas/common` import point the issue names,
 * covering parsing, defaulting, coercion of query-string values, and the
 * rejection of every malformed input class a list endpoint can receive.
 */
describe("paginationQuerySchema (src/schemas/common)", () => {
  it("exports the same schema object as the canonical pagination module", async () => {
    const canonical = await import("../../src/lib/pagination");
    expect(paginationQuerySchema).toBe(canonical.paginationQuerySchema);
    expect(DEFAULT_PAGE_SIZE).toBe(canonical.DEFAULT_PAGE_SIZE);
    expect(MAX_PAGE_SIZE).toBe(canonical.MAX_PAGE_SIZE);
  });

  it("applies the documented defaults when the query is empty", () => {
    const parsed = paginationQuerySchema.parse({});

    expect(parsed.limit).toBe(DEFAULT_PAGE_SIZE);
    expect(parsed.limit).toBe(50);
    expect(parsed.order).toBe("desc");
    expect(parsed.cursor).toBeUndefined();
  });

  it("accepts an explicit page size and order", () => {
    const parsed = paginationQuerySchema.parse({ limit: "25", order: "asc" });

    expect(parsed.limit).toBe(25);
    expect(parsed.order).toBe("asc");
  });

  it("coerces query-string values, which always arrive as strings", () => {
    const parsed = paginationQuerySchema.parse({
      limit: "10",
      cursor: "Y3Vyc29y",
      order: "asc",
    });

    expect(parsed.limit).toBe(10);
    expect(parsed.cursor).toBe("Y3Vyc29y");
    expect(parsed.order).toBe("asc");
  });

  it("accepts the boundary page sizes 1 and MAX_PAGE_SIZE", () => {
    expect(paginationQuerySchema.parse({ limit: 1 }).limit).toBe(1);
    expect(paginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE) }).limit).toBe(
      MAX_PAGE_SIZE
    );
  });

  it("rejects a page size over the maximum instead of clamping", () => {
    // Silent clamping would hide a client bug; the contract is a VALIDATION_ERROR.
    expect(() => paginationQuerySchema.parse({ limit: MAX_PAGE_SIZE + 1 })).toThrow();
    expect(() =>
      paginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE + 1) })
    ).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "9999" })).toThrow();
  });

  it("rejects zero and negative page sizes", () => {
    expect(() => paginationQuerySchema.parse({ limit: 0 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: -1 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "-5" })).toThrow();
  });

  it("rejects non-integer and non-numeric page sizes", () => {
    expect(() => paginationQuerySchema.parse({ limit: 1.5 })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "2.75" })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "many" })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: "" })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: null })).toThrow();
  });

  it("rejects an empty cursor string", () => {
    expect(() => paginationQuerySchema.parse({ cursor: "" })).toThrow();
  });

  it("rejects a cursor over the 512-character bound", () => {
    expect(() => paginationQuerySchema.parse({ cursor: "a".repeat(513) })).toThrow();
    expect(
      paginationQuerySchema.parse({ cursor: "a".repeat(512) }).cursor
    ).toHaveLength(512);
  });

  it("rejects an unknown order value", () => {
    expect(() => paginationQuerySchema.parse({ order: "sideways" })).toThrow();
    expect(() => paginationQuerySchema.parse({ order: "" })).toThrow();
    expect(() => paginationQuerySchema.parse({ order: "DESC" })).toThrow();
  });

  it("rejects unknown query parameters instead of stripping them", () => {
    // The schema is strict: `?page=3` on a cursor-based endpoint is a client
    // bug, and silently dropping the key would let a caller believe page-based
    // paging worked.
    expect(() => paginationQuerySchema.parse({ page: 3 })).toThrow();
    expect(() => paginationQuerySchema.parse({ evil: "<script>" })).toThrow();
    expect(() => paginationQuerySchema.parse({ limit: 10, page: 2 })).toThrow();
  });

  it("rejects non-object input", () => {
    expect(() => paginationQuerySchema.parse(null)).toThrow();
    expect(() => paginationQuerySchema.parse("limit=10")).toThrow();
    expect(() => paginationQuerySchema.parse([1, 2])).toThrow();
  });

  it("reports which parameter failed validation", () => {
    const result = paginationQuerySchema.safeParse({ limit: -1, cursor: "", order: "x" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((issue) => issue.path[0]);
      expect(paths).toContain("limit");
      expect(paths).toContain("cursor");
      expect(paths).toContain("order");
    }
  });
});
