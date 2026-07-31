import { describe, it, expect, beforeAll, vi } from "vitest";

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

import { buildApp } from "../src/app";
import { AppError, Errors, ErrorCode } from "../src/lib/errors";
import { z } from "zod";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

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

  app.get("/test/upstream", async () => {
    throw Errors.upstream("Anchor service unavailable");
  });

  app.get("/test/with-details", async () => {
    throw new AppError(400, "VALIDATION_ERROR", "Bad input", [
      { field: "amount", message: "Required" },
    ]);
  });

  app.get("/test/zod-error", async () => {
    z.object({ name: z.string().min(1) }).parse({ name: "" });
  });

  app.get("/test/zod-nested", async () => {
    z.object({ user: z.object({ age: z.number().min(18) }) }).parse({ user: { age: 15 } });
  });

  app.get("/test/internal", async () => {
    throw new Error("DB exploded: secret connection string");
  });
});

describe("AppError transformation", () => {
  it("maps 404 NOT_FOUND to standard envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/test/not-found" });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.NOT_FOUND);
    expect(body.message).toBe("Thing not found");
    expect(body.requestId).toBeTruthy();
    expect(body.details).toBeUndefined();
  });

  it("maps 401 UNAUTHORIZED correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/unauthorized" });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.UNAUTHORIZED);
    expect(body.requestId).toBeTruthy();
  });

  it("maps 403 FORBIDDEN correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/forbidden" });

    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.FORBIDDEN);
    expect(body.message).toBe("Access denied");
    expect(body.requestId).toBeTruthy();
  });

  it("maps 400 INVALID_ACCOUNT correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/bad-request" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("INVALID_ACCOUNT");
    expect(body.message).toBe("Not a valid Stellar public key");
    expect(body.requestId).toBeTruthy();
  });

  it("maps 409 ALREADY_SETTLED correctly", async () => {
    const res = await app.inject({ method: "GET", url: "/test/conflict" });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe("ALREADY_SETTLED");
    expect(body.requestId).toBeTruthy();
  });

  it("maps 502 UPSTREAM_ERROR with generic message", async () => {
    const res = await app.inject({ method: "GET", url: "/test/upstream" });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.message).toBe("Anchor service unavailable");
    expect(body.requestId).toBeTruthy();
    expect(body.details).toBeUndefined();
  });

  it("includes details when AppError has a details payload", async () => {
    const res = await app.inject({ method: "GET", url: "/test/with-details" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("amount");
    expect(body.requestId).toBeTruthy();
  });

  it("does NOT expose a stack trace in the response", async () => {
    const res = await app.inject({ method: "GET", url: "/test/not-found" });

    const body = res.json();
    expect(body.stack).toBeUndefined();
  });
});

describe("ZodError (validation) transformation", () => {
  it("maps ZodError to VALIDATION_ERROR with details array", async () => {
    const res = await app.inject({ method: "GET", url: "/test/zod-error" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
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
    const res = await app.inject({ method: "GET", url: "/test/zod-error" });

    const body = res.json();
    expect(body.stack).toBeUndefined();
  });

  it("includes field-level details for nested Zod schemas", async () => {
    const res = await app.inject({ method: "GET", url: "/test/zod-nested" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("user.age");
    expect(body.details[0].message).toContain("18");
    expect(body.requestId).toBeTruthy();
  });
});

describe("Unhandled / unexpected errors", () => {
  it("converts unexpected Error to INTERNAL_ERROR without leaking details", async () => {
    const res = await app.inject({ method: "GET", url: "/test/internal" });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("Something went wrong.");
    expect(body.requestId).toBeTruthy();
    expect(body.message).not.toContain("DB exploded");
    expect(body.stack).toBeUndefined();
  });
});

describe("404 — unknown routes", () => {
  it("returns standard NOT_FOUND envelope for an unknown route", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/this/does/not/exist/at/all",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.code).toBe("NOT_FOUND");
    expect(body.message).toBeTruthy();
    expect(body.requestId).toBeTruthy();
  });
});

describe("requestId correlation", () => {
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

describe("standard response shape contract", () => {
  it.each([
    { url: "/test/not-found", expectedStatus: 404, expectedCode: "NOT_FOUND" },
    { url: "/test/unauthorized", expectedStatus: 401, expectedCode: "UNAUTHORIZED" },
    { url: "/test/forbidden", expectedStatus: 403, expectedCode: "FORBIDDEN" },
    { url: "/test/bad-request", expectedStatus: 400, expectedCode: "INVALID_ACCOUNT" },
    { url: "/test/conflict", expectedStatus: 409, expectedCode: "ALREADY_SETTLED" },
    { url: "/test/upstream", expectedStatus: 502, expectedCode: "UPSTREAM_ERROR" },
    { url: "/test/internal", expectedStatus: 500, expectedCode: "INTERNAL_ERROR" },
  ])(
    "$url returns { code, message, requestId } with status $expectedStatus",
    async ({ url, expectedStatus, expectedCode }) => {
      const res = await app.inject({ method: "GET", url });

      expect(res.statusCode).toBe(expectedStatus);
      const body = res.json();
      expect(typeof body.code).toBe("string");
      expect(typeof body.message).toBe("string");
      expect(typeof body.requestId).toBe("string");
      expect(body.code).toBe(expectedCode);
      expect(body.statusCode).toBeUndefined();
    },
  );
});
