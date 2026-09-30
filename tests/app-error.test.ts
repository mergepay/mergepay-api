import { describe, it, expect } from "vitest";
import {
  AppError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  BadRequestError,
  InternalServerError,
} from "../src/errors";
import * as errorsModule from "../src/errors";

describe("Custom Domain-Specific Error Classes", () => {
  it("exports all error classes cleanly from src/errors", () => {
    expect(errorsModule.AppError).toBeDefined();
    expect(errorsModule.NotFoundError).toBeDefined();
    expect(errorsModule.ValidationError).toBeDefined();
    expect(errorsModule.UnauthorizedError).toBeDefined();
    expect(errorsModule.ForbiddenError).toBeDefined();
    expect(errorsModule.ConflictError).toBeDefined();
    expect(errorsModule.BadRequestError).toBeDefined();
    expect(errorsModule.InternalServerError).toBeDefined();
  });

  describe("NotFoundError (404)", () => {
    it("sets default status code, error code, and message", () => {
      const err = new NotFoundError();
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("NotFoundError");
      expect(err.status).toBe(404);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.message).toBe("Not found");
      expect(err.details).toBeUndefined();
    });

    it("accepts custom message and details", () => {
      const details = { resource: "Expense", id: "exp-123" };
      const err = new NotFoundError("Expense not found", details);
      expect(err.message).toBe("Expense not found");
      expect(err.status).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.details).toEqual(details);
    });
  });

  describe("ValidationError (400)", () => {
    it("sets default status code, error code, and message", () => {
      const err = new ValidationError();
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("ValidationError");
      expect(err.status).toBe(400);
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.message).toBe("Validation failed");
    });

    it("accepts custom message and validation issue details", () => {
      const issues = [{ field: "amount", message: "Amount must be positive" }];
      const err = new ValidationError("Invalid payload", issues);
      expect(err.message).toBe("Invalid payload");
      expect(err.status).toBe(400);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err.details).toEqual(issues);
    });
  });

  describe("UnauthorizedError (401)", () => {
    it("sets default status code, error code, and message", () => {
      const err = new UnauthorizedError();
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("UnauthorizedError");
      expect(err.status).toBe(401);
      expect(err.statusCode).toBe(401);
      expect(err.code).toBe("UNAUTHORIZED");
      expect(err.message).toBe("Unauthorized");
    });

    it("accepts custom message and details", () => {
      const err = new UnauthorizedError("Invalid signature", { hint: "Check keypair" });
      expect(err.message).toBe("Invalid signature");
      expect(err.status).toBe(401);
      expect(err.code).toBe("UNAUTHORIZED");
      expect(err.details).toEqual({ hint: "Check keypair" });
    });
  });

  describe("ForbiddenError (403)", () => {
    it("sets default status code, error code, and message", () => {
      const err = new ForbiddenError();
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("ForbiddenError");
      expect(err.status).toBe(403);
      expect(err.statusCode).toBe(403);
      expect(err.code).toBe("FORBIDDEN");
      expect(err.message).toBe("Forbidden");
    });

    it("accepts custom message and details", () => {
      const err = new ForbiddenError("Only admins can perform this action");
      expect(err.message).toBe("Only admins can perform this action");
      expect(err.status).toBe(403);
      expect(err.code).toBe("FORBIDDEN");
    });
  });

  describe("ConflictError (409)", () => {
    it("sets default status code, error code, and message", () => {
      const err = new ConflictError();
      expect(err).toBeInstanceOf(AppError);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("ConflictError");
      expect(err.status).toBe(409);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("CONFLICT");
      expect(err.message).toBe("Conflict");
    });

    it("accepts custom message and details", () => {
      const err = new ConflictError("Settlement is already settled", { settlementId: "s-1" });
      expect(err.message).toBe("Settlement is already settled");
      expect(err.status).toBe(409);
      expect(err.code).toBe("CONFLICT");
      expect(err.details).toEqual({ settlementId: "s-1" });
    });
  });

  describe("BadRequestError (400)", () => {
    it("sets status 400 and BAD_REQUEST code", () => {
      const err = new BadRequestError("Invalid cursor");
      expect(err).toBeInstanceOf(AppError);
      expect(err.status).toBe(400);
      expect(err.code).toBe("BAD_REQUEST");
      expect(err.message).toBe("Invalid cursor");
    });

    it("allows specifying a custom error code string", () => {
      const err = new BadRequestError("Malformed XDR", undefined, "XDR_MALFORMED");
      expect(err.status).toBe(400);
      expect(err.code).toBe("XDR_MALFORMED");
      expect(err.message).toBe("Malformed XDR");
    });
  });

  describe("InternalServerError (500)", () => {
    it("sets status 500 and INTERNAL_ERROR code", () => {
      const err = new InternalServerError();
      expect(err).toBeInstanceOf(AppError);
      expect(err.status).toBe(500);
      expect(err.code).toBe("INTERNAL_ERROR");
      expect(err.message).toBe("Internal server error");
    });
  });

  describe("AppError base class", () => {
    it("sets status, code, message, and details correctly", () => {
      const err = new AppError(422, "UNPROCESSABLE", "Cannot process", { field: "name" });
      expect(err.status).toBe(422);
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe("UNPROCESSABLE");
      expect(err.message).toBe("Cannot process");
      expect(err.details).toEqual({ field: "name" });
      expect(err.name).toBe("AppError");
    });

    it("allows setting requestId dynamically by error handlers", () => {
      const err = new AppError(400, "BAD_REQUEST", "Bad request");
      err.requestId = "req-test-123";
      expect(err.requestId).toBe("req-test-123");
    });
  });
});
