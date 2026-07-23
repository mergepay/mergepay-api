import { describe, it, expect, vi } from "vitest";
import { ZodError, z } from "zod";
import { AppError, Errors } from "../src/lib/errors";

describe("AppError", () => {
  it("creates an error with statusCode, code, message, and details", () => {
    const err = new AppError(400, "VALIDATION_ERROR", "Bad input", [{ field: "name" }]);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.message).toBe("Bad input");
    expect(err.details).toEqual([{ field: "name" }]);
    expect(err.name).toBe("AppError");
  });
});

describe("Errors factory", () => {
  it("creates unauthorized error", () => {
    const err = Errors.unauthorized();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe("UNAUTHORIZED");
  });

  it("creates forbidden error", () => {
    const err = Errors.forbidden();
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe("FORBIDDEN");
  });

  it("creates notFound error", () => {
    const err = Errors.notFound();
    expect(err.statusCode).toBe(404);
    expect(err.code).toBe("NOT_FOUND");
  });

  it("creates badRequest error with details", () => {
    const err = Errors.badRequest("INVALID_FIELD", "Name is required", [{ field: "name" }]);
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe("INVALID_FIELD");
    expect(err.details).toEqual([{ field: "name" }]);
  });

  it("creates conflict error", () => {
    const err = Errors.conflict("DUPLICATE", "Already exists");
    expect(err.statusCode).toBe(409);
    expect(err.code).toBe("DUPLICATE");
  });

  it("creates upstream error", () => {
    const err = Errors.upstream("Stellar timeout");
    expect(err.statusCode).toBe(502);
    expect(err.code).toBe("UPSTREAM_ERROR");
  });
});

describe("ZodError mapping", () => {
  it("can be created from a Zod schema parse failure", () => {
    const schema = z.object({ name: z.string() });
    try {
      schema.parse({ name: 123 });
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError);
      const zod = e as ZodError;
      expect(zod.errors[0].path).toContain("name");
    }
  });
});
