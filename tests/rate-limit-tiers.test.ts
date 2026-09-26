/**
 * Rate-limit tiers against the real application (#546).
 *
 * tests/rate-limit-headers.test.ts and tests/rate-limit-policies.test.ts
 * exercise the plugin and the policy table against synthetic apps. They
 * cannot prove the part #546 cares about: that a limit rejection issued by
 * the *real* registration in src/app.ts — whose errorResponseBuilder throws
 * an AppError that the central error handler renders — reaches the client as
 * a 429 with the standard error envelope and the rate-limit headers, at
 * every tier (global, SEP-10 auth, settlement confirmation).
 *
 * These tests build the real app with the database mocked out, spend each
 * tier's budget with requests that fail *after* the limiter (so a 400/403
 * proves the request was not limited), and assert the boundary request is a
 * 429. No test reads the real clock or sleeps: the counters live in the
 * plugin's in-memory store, which is fresh per built app.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    settlement: model(),
    expense: model(),
    idempotencyKey: model(),
    statusHistory: model(),
    refreshToken: model(),
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { rateLimitPolicies } from "../src/lib/rate-limit";

const prisma = h.prisma;

function authHeader() {
  const token = signToken({
    id: "user_1",
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

async function buildAppWithGlobalRateLimitProbe() {
  const app = await buildApp();
  app.get("/test/global-rate-limit", async () => ({ ok: true }));
  return app;
}

beforeEach(async () => {
  vi.clearAllMocks();
  // The confirmation handler rejects a non-payer with 403 after the
  // membership lookup — reached only when the limiter let the request
  // through, which is exactly what the tier tests need.
  prisma.settlement.findUnique.mockResolvedValue({
    id: "settle_1",
    groupId: "group_1",
    fromUserId: "user_2",
    toUserId: "user_1",
    status: "pending",
  });
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: "group_1",
    userId: "user_1",
    role: "member",
  });
});

/** The standardized error contract every 429 body must satisfy. */
function expectStandardRateLimitBody(res: { json: () => any; headers: Record<string, unknown> }) {
  const body = res.json();
  expect(body.code).toBe("RATE_LIMITED");
  // Canonical envelope (src/utils/error-response.ts): the `error` field is the
  // nested payload object, and the flat code/message/requestId fields are the
  // backwards-compatible mirror the central error handler also emits.
  expect(body.error).toMatchObject({ code: "RATE_LIMITED", message: body.message });
  expect(typeof body.message).toBe("string");
  expect(body.message.length).toBeGreaterThan(0);
  expect(typeof body.requestId).toBe("string");
  expect(body.requestId.length).toBeGreaterThan(0);
  expect(body.error).not.toHaveProperty("statusCode");
  expect(body.error).not.toHaveProperty("stack");
  // The 429 is a client error, never a sanitized crash: no leak fields.
  expect(body).not.toHaveProperty("statusCode");
  expect(body).not.toHaveProperty("stack");
  expect(body.requestId).toBe(res.headers["x-request-id"]);
}

describe("global tier (real app)", () => {
  it("spends the budget on under-limit requests, reporting remaining", async () => {
    const app = await buildAppWithGlobalRateLimitProbe();
    const { max } = rateLimitPolicies().global;

    const first = await app.inject({ method: "GET", url: "/test/global-rate-limit" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(first.headers["x-ratelimit-remaining"]).toBe(String(max - 1));
    expect(first.headers["retry-after"]).toBeUndefined();
    await app.close();
  });

  it("answers the request that crosses the limit with 429, headers, and the standard error body", async () => {
    const app = await buildAppWithGlobalRateLimitProbe();
    const { max } = rateLimitPolicies().global;

    for (let i = 0; i < max; i++) {
      const res = await app.inject({ method: "GET", url: "/test/global-rate-limit" });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: "GET", url: "/test/global-rate-limit" });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);
    await app.close();
  });
});

describe("SEP-10 auth tiers (real app)", () => {
  it("rate limits POST /auth/challenge to its own tight budget", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().authChallenge;

    // Under the limit the malformed body is a validation error — proof the
    // limiter passed the request through rather than blocking it.
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);
    await app.close();
  });

  it("rate limits POST /auth/verify separately from challenge", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().authVerify;

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expectStandardRateLimitBody(limited);

    // Exhausting the verify bucket must not have spent the challenge budget.
    const challenge = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: {},
    });
    expect(challenge.statusCode).toBe(400);
    await app.close();
  });
});

describe("settlement confirmation tier (real app)", () => {
  it("answers the request that crosses the confirmation limit with 429", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().settlementConfirm;

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/settlements/settle_1/confirm",
        headers: { ...authHeader(), "idempotency-key": `confirm-key-${i}` },
        payload: { signedXdr: "AAAA" },
      });
      // Payer mismatch: the handler ran, the limiter did not block.
      expect(res.statusCode).toBe(403);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-over" },
      payload: { signedXdr: "AAAA" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);
    await app.close();
  });
});
