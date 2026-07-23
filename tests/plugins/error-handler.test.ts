import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("../../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    group: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
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

import { buildApp } from "../../src/app";
import { z } from "zod";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

  app.get("/test-zod/simple", async () => {
    z.object({ name: z.string().min(1) }).parse({ name: "" });
  });

  app.get("/test-zod/nested", async () => {
    z.object({
      user: z.object({
        age: z.number().min(18),
      }),
    }).parse({ user: { age: 15 } });
  });
});

describe("Zod validation error handler", () => {
  it("returns 400 with structured details for simple Zod validation failure", async () => {
    const res = await app.inject({ method: "GET", url: "/test-zod/simple" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0]).toMatchObject({
      field: expect.any(String),
      message: expect.any(String),
      code: expect.any(String),
    });
    expect(body.requestId).toBeTruthy();
  });

  it("returns field-level details for nested Zod schemas", async () => {
    const res = await app.inject({ method: "GET", url: "/test-zod/nested" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("user.age");
    expect(body.details[0].message).toContain("18");
    expect(body.requestId).toBeTruthy();
  });

  it("does not affect 404 responses for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent-route-xyz" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.statusCode).toBe(404);
  });

  it("returns 400 for malformed POST body to a route with Zod validation", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
  });
});
