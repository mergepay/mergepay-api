/**
 * Unit tests for the centralised error handler registered in src/app.ts.
 *
 * We build a single dedicated Fastify instance that has all test error routes
 * pre-registered before any inject() call triggers the listen lifecycle.
 * This avoids the "Cannot add route after server has started" error.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock("../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    group: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn() },
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------
import { buildApp } from "../src/app";
import { AppError, Errors, ErrorCode } from "../src/lib/errors";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Build a single app with ALL test routes pre-registered
// ---------------------------------------------------------------------------
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

  // Register all test routes BEFORE inject() triggers the server to start.
  // Each route has a unique path to avoid collisions with real routes.

  app.get("/test/not-found", async () => {
    throw Errors.notFound("Thing not found");
  });

  app.get("/test/unauthorized", async () => {
    throw Errors.unauthorized();
  });

  app.get("/test/forbidden", async () => {
    throw Errors.forbidden("Access denied");
  });

  app.get("/test/bad-request", async () => {
    throw Errors.badRequest("invalid_account", "Not a valid Stellar public key");
  });

  app.get("/test/conflict", async () => {
    throw Errors.conflict("already_settled", "Your share is already settled");
  });

  app.get("/test/with-details", async () => {
    throw new AppError(400, "VALIDATION_ERROR", "Bad input", [
      { field: "amount", message: "Required" },
    ]);
  });

  app.get("/test/no-stack", async () => {
    throw new AppError(400, "BAD_REQUEST", "Bad");
  });

  app.get("/test/zod-error", async () => {
    z.object({ name: z.string().min(1) }).parse({ name: "" });
  });

  app.get("/test/zod-no-stack", async () => {
    z.object({ value: z.number() }).parse({ value: "not-a-number" });
  });

  app.get("/test/internal", async () => {
    throw new Error("DB exploded: secret connection string");
  });
});

// ---------------------------------------------------------------------------
// AppError transformation
// ---------------------------------------------------------------------------
describe("error handler — AppError", () => {
  it("maps a 404 AppError to the standard envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/test/not-found" });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe(ErrorCode.NOT_FOUND);
    expect(body.message).toBe("Thing not found");
    expect(body.statusCode).toBe(404);
    expect(body.requestId).toBeTruthy();
    expect(body.details).toBeUndefined();
  });

  it("maps a 401 AppError (unauthorized) correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/unauthorized" });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe(ErrorCode.UNAUTHORIZED);
    expect(body.statusCode).toBe(401);
    expect(body.requestId).toBeTruthy();
  });

  it("maps a 403 AppError (forbidden) correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/forbidden" });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe("Access denied");
    expect(body.statusCode).toBe(403);
    expect(body.requestId).toBeTruthy();
  });

  it("maps a 400 badRequest AppError correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/bad-request" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("INVALID_ACCOUNT");
    expect(body.message).toBe("Not a valid Stellar public key");
    expect(body.statusCode).toBe(400);
    expect(body.requestId).toBeTruthy();
  });

  it("maps a 409 conflict AppError correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/conflict" });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("ALREADY_SETTLED");
    expect(body.statusCode).toBe(409);
    expect(body.requestId).toBeTruthy();
  });

  it("includes details when AppError has a details payload", async () => {
    const res = await app.inject({ method: "GET", url: "/test/with-details" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("amount");
    expect(body.requestId).toBeTruthy();
  });

  it("does NOT expose a stack trace in the response", async () => {
    const res = await app.inject({ method: "GET", url: "/test/no-stack" });

    const body = res.json();
    expect(body.stack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ZodError transformation
// ---------------------------------------------------------------------------
describe("error handler — ZodError (validation)", () => {
  it("maps a ZodError to VALIDATION_ERROR with details array", async () => {
    const res = await app.inject({ method: "GET", url: "/test/zod-error" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
    expect(body.message).toBeTruthy();
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0]).toMatchObject({
      field: expect.any(String),
      message: expect.any(String),
      code: expect.any(String),
    });
    expect(body.requestId).toBeTruthy();
  });

  it("does not leak a stack trace for ZodErrors", async () => {
    const res = await app.inject({ method: "GET", url: "/test/zod-no-stack" });

    const body = res.json();
    expect(body.stack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Unhandled / unexpected errors (internal)
// ---------------------------------------------------------------------------
describe("error handler — unhandled errors", () => {
  it("converts an unexpected Error to INTERNAL_ERROR without leaking details", async () => {
    const res = await app.inject({ method: "GET", url: "/test/internal" });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("Something went wrong.");
    expect(body.statusCode).toBe(500);
    expect(body.requestId).toBeTruthy();
    // Must NOT leak the original message or stack.
    expect(body.message).not.toContain("DB exploded");
    expect(body.stack).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 404 — unknown routes (setNotFoundHandler)
// ---------------------------------------------------------------------------
describe("error handler — not found routes", () => {
  it("returns a standard NOT_FOUND envelope for an unknown route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/this/does/not/exist/at/all",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.message).toBeTruthy();
    expect(body.statusCode).toBe(404);
    expect(body.requestId).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// requestId correlation
// ---------------------------------------------------------------------------
describe("error handler — requestId correlation", () => {
  it("returns a non-empty requestId string for every error response", async () => {
    const urls = [
      "/this/does/not/exist",
      "/test/not-found",
      "/test/unauthorized",
    ];

    for (const url of urls) {
      const res = await app.inject({ method: "GET", url });
      const body = res.json();
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId.length).toBeGreaterThan(0);
    }
  });

  it("returns different requestIds for different requests", async () => {
    const res1 = await app.inject({ method: "GET", url: "/this/does/not/exist" });
    const res2 = await app.inject({ method: "GET", url: "/this/does/not/exist" });

    expect(res1.json().requestId).not.toBe(res2.json().requestId);
  });
});

// ---------------------------------------------------------------------------
// Standard shape contract
// ---------------------------------------------------------------------------
describe("error handler — response shape contract", () => {
  it.each([
    { url: "/test/not-found", expectedStatus: 404, expectedCode: "NOT_FOUND" },
    { url: "/test/unauthorized", expectedStatus: 401, expectedCode: "UNAUTHORIZED" },
    { url: "/test/forbidden", expectedStatus: 403, expectedCode: "FORBIDDEN" },
    { url: "/test/bad-request", expectedStatus: 400, expectedCode: "INVALID_ACCOUNT" },
    { url: "/test/conflict", expectedStatus: 409, expectedCode: "ALREADY_SETTLED" },
    { url: "/test/internal", expectedStatus: 500, expectedCode: "INTERNAL_ERROR" },
  ])(
    "$url returns { error, message, statusCode, requestId } with status $expectedStatus",
    async ({ url, expectedStatus, expectedCode }) => {
      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(expectedStatus);
      const body = res.json();
      // All four required fields must be present.
      expect(typeof body.error).toBe("string");
      expect(typeof body.message).toBe("string");
      expect(typeof body.statusCode).toBe("number");
      expect(typeof body.requestId).toBe("string");
      // statusCode in body must match HTTP status.
      expect(body.statusCode).toBe(expectedStatus);
      expect(body.error).toBe(expectedCode);
    },
  );
});
