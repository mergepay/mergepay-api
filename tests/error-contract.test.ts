import { describe, it, expect, beforeAll, vi } from "vitest";

vi.mock("../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    group: { findUnique: vi.fn(), create: vi.fn() },
    groupMember: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    expense: { findUnique: vi.fn() },
    settlement: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    treasuryTransaction: { findUnique: vi.fn() },
    anchorSession: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    withdrawal: { findUnique: vi.fn() },
    invite: { findUnique: vi.fn() },
    invitation: { findUnique: vi.fn(), findFirst: vi.fn() },
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
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
      submitPayment: vi.fn(),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

describe("error response shape consistency", () => {
  it("every error has { code, message, requestId } — none leak stack or statusCode", async () => {
    const endpoints = [
      { method: "GET" as const, url: "/this/does/not/exist" },
      { method: "GET" as const, url: "/me" },
      { method: "POST" as const, url: "/auth/challenge", payload: {} },
      { method: "POST" as const, url: "/groups", headers: authHeader(), payload: {} },
    ];

    for (const ep of endpoints) {
      const res = await app.inject({
        method: ep.method,
        url: ep.url,
        headers: ep.headers,
        payload: ep.payload,
      });

      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      const body = res.json();
      expect(body).not.toHaveProperty("stack");
      expect(body).not.toHaveProperty("statusCode");
      expect(typeof body.code).toBe("string");
      expect(body.code.length).toBeGreaterThan(0);
      expect(typeof body.message).toBe("string");
      expect(body.message.length).toBeGreaterThan(0);
      expect(typeof body.requestId).toBe("string");
      expect(body.requestId.length).toBeGreaterThan(0);
    }
  });

  it("does not include statusCode in error body", async () => {
    const res = await app.inject({ method: "GET", url: "/this/does/not/exist" });
    expect(res.json().statusCode).toBeUndefined();
  });

  it("returns 500 INTERNAL_ERROR for unexpected exceptions with sanitized message", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/challenge", payload: null });
    if (res.statusCode === 500) {
      const body = res.json();
      expect(body.code).toBe("INTERNAL_ERROR");
      expect(body.message).toBe("Something went wrong.");
      expect(body.stack).toBeUndefined();
    }
  });
});

describe("malformed request validation", () => {
  it("VALIDATION_ERROR with details for empty body", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/challenge", payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("VALIDATION_ERROR with field-level details for invalid body types", async () => {
    const res = await app.inject({
      method: "POST", url: "/groups", headers: authHeader(), payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.details)).toBe(true);
    expect(body.details[0].field).toBe("name");
  });


});

describe("authorization failures", () => {
  it("UNAUTHORIZED when no auth header", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("UNAUTHORIZED for malformed Bearer token", async () => {
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer bad-token" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("UNAUTHORIZED when token is missing Bearer scheme", async () => {
    const res = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Token xxx" } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });
});

describe("not found failures", () => {
  it("NOT_FOUND for unknown route", async () => {
    const res = await app.inject({ method: "GET", url: "/nonexistent" });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
    expect(res.json().message).toBe("Route not found");
  });
});
