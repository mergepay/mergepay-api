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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    // Reached by the #668 tiers: minting an invite code, redeeming one, and
    // registering an outbound webhook each read or wrote one of these.
    invite: model(),
    invitation: model(),
    webhook: model(),
    auditLog: { create: vi.fn() },
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
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

function authHeader(
  userId = "user_1",
  publicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
) {
  const token = signToken({
    id: userId,
    stellarPublicKey: publicKey,
  });
  return { authorization: `Bearer ${token}` };
}

async function buildAppWithGlobalRateLimitProbe() {
  const app = await buildApp();
  app.get("/test/global-rate-limit", async () => ({ ok: true }));
  return app;
}

/**
 * A multipart body for the receipt route, deliberately carrying a content
 * type the route rejects. The rejection happens before anything is written to
 * disk, so the tier tests can spend the budget `max` times without leaving
 * files behind, and the 400 proves the handler ran.
 */
function rejectedReceiptUpload(): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const boundary = "----mergepayTierBoundary";
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        'Content-Disposition: form-data; name="file"; filename="receipt.bin"\r\n' +
        "Content-Type: application/x-msdownload\r\n\r\n"
    ),
    Buffer.alloc(64, 0x89),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return {
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    payload,
  };
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
  // A row complete enough for the registration response, so POST /api/webhooks
  // answers 201 when the limiter lets it through.
  prisma.webhook.create.mockResolvedValue({
    id: "wh_1",
    groupId: null,
    userId: "user_1",
    url: "https://example.test/hook",
    secret: "whsec_test",
    events: ["expense.created"],
    enabled: true,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
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

    // Health check and public read endpoints remain unaffected after confirmation limit exhaustion (#529)
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const healthLive = await app.inject({ method: "GET", url: "/health/live" });
    expect(healthLive.statusCode).toBe(200);

    await app.close();
  });
});

describe("expense settlement submission tier (real app) (#529)", () => {
  it("answers the request that crosses the settlement submission limit with 429", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().settlementCreate;
    const headers = authHeader("user_1");

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/expenses/expense_1/settle",
        headers,
        payload: {},
      });
      // Expense not found: the route handler ran and was not blocked by rate limiting.
      expect(res.statusCode).toBe(404);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers,
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);

    // Health check and public read endpoints remain unaffected by strict settlement rate limits (#529)
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    const healthLive = await app.inject({ method: "GET", url: "/health/live" });
    expect(healthLive.statusCode).toBe(200);

    // Another authenticated user maintains their own independent budget
    const user2Headers = authHeader("user_2", "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    const user2Res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: user2Headers,
      payload: {},
    });
    expect(user2Res.statusCode).not.toBe(429);
    expect(user2Res.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(user2Res.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    await app.close();
  });
});

describe("settlement execution submission tier (real app) (#529)", () => {
  it("answers the request that crosses the settlement execute limit with 429", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().settlementExecute;
    const headers = authHeader("user_1");

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/settlements/execute",
        headers: { ...headers, "x-idempotency-key": `exec-key-${i}` },
        payload: { settlementId: "settle_1", signedXdr: "AAAA" },
      });
      // Payer mismatch: the handler ran and rejected with 403, not rate-limited.
      expect(res.statusCode).toBe(403);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/settlements/execute",
      headers: { ...headers, "x-idempotency-key": "exec-key-over" },
      payload: { settlementId: "settle_1", signedXdr: "AAAA" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);

    // Health check remains unaffected
    const healthLive = await app.inject({ method: "GET", url: "/health/live" });
    expect(healthLive.statusCode).toBe(200);

    await app.close();
  });
});

/**
 * The tiers #668 added, against the real app.
 *
 * Each of these routes used to answer from the caller's *global* allowance,
 * which is the one bucket no single caller can exhaust on purpose. So the
 * routes were nominally limited and practically unlimited: a public scan of
 * the rates endpoint, a walk of invite codes, or a retrying webhook
 * registration spent a general allowance the same identity then needed for
 * dashboard polling. These tests pin the opposite behaviour: a dedicated
 * budget, advertised on the very first in-budget response (which is what
 * fails if the `rateLimited(...)` annotation is ever dropped from a route
 * declaration and the route silently inherits the global numbers).
 */

describe("exchange rate read tier (real app) (#668)", () => {
  beforeEach(() => {
    // The route quotes from Horizon's order book. Stubbing fetch keeps the
    // tier measurement honest: without it, every in-budget request would
    // attempt a real network read (and, offline, spend retry backoff) rather
    // than proving the limiter let it through.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ asks: [{ price: "0.11" }], bids: [{ price: "0.09" }] }),
      }))
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("advertises its own budget on the in-budget responses, then 429s at the boundary", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().exchangeRates;
    const remoteAddress = "203.0.113.11";

    const first = await app.inject({
      method: "GET",
      url: "/api/exchange-rates",
      remoteAddress,
    });
    expect(first.statusCode).toBe(200);
    // The advertised limit is this policy's, not the global default.
    expect(first.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(first.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    for (let i = 1; i < max; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/exchange-rates",
        remoteAddress,
      });
      expect(res.statusCode).toBe(200);
    }

    const limited = await app.inject({
      method: "GET",
      url: "/api/exchange-rates",
      remoteAddress,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);
    await app.close();
  });

  it("keys the read by source address and leaves the global allowance intact", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().exchangeRates;
    const policies = rateLimitPolicies();
    const noisy = "203.0.113.12";

    for (let i = 0; i < max; i++) {
      await app.inject({ method: "GET", url: "/api/exchange-rates", remoteAddress: noisy });
    }
    expect(
      (await app.inject({ method: "GET", url: "/api/exchange-rates", remoteAddress: noisy }))
        .statusCode
    ).toBe(429);

    // A different address scanning rates cannot throttle its neighbours.
    const neighbour = await app.inject({
      method: "GET",
      url: "/api/exchange-rates",
      remoteAddress: "203.0.113.13",
    });
    expect(neighbour.statusCode).toBe(200);
    expect(neighbour.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    // The point of the tier: the scanning address still holds its full general
    // allowance for routes without their own budget.
    const global = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(),
      remoteAddress: noisy,
    });
    expect(global.statusCode).not.toBe(429);
    expect(global.headers["x-ratelimit-limit"]).toBe(String(policies.global.max));

    const health = await app.inject({ method: "GET", url: "/health", remoteAddress: noisy });
    expect(health.statusCode).toBe(200);

    await app.close();
  });
});

describe("group invite tier (real app) (#668)", () => {
  it("answers the request that crosses the invite limit with 429", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().groupInvite;
    const headers = authHeader();

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/groups/group_1/invite",
        headers,
        payload: {},
      });
      // Not an admin: the guard ran, so the limiter passed the request.
      expect(res.statusCode).toBe(403);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/groups/group_1/invite",
      headers,
      payload: {},
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);

    // Invite spam must not burn the caller's group-creation allowance: the two
    // buckets have different prefixes precisely so one cannot spend the other.
    const create = await app.inject({
      method: "POST",
      url: "/groups",
      headers,
      payload: { name: "Independent budget check" },
    });
    expect(create.statusCode).not.toBe(429);
    expect(create.headers["x-ratelimit-limit"]).toBe(
      String(rateLimitPolicies().groupCreate.max)
    );

    await app.close();
  });
});

describe("group join tier (real app) (#668)", () => {
  it("limits code redemption per source address, ahead of authentication", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().groupJoin;
    const remoteAddress = "203.0.113.21";

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/groups/join",
        remoteAddress,
        payload: { code: "AAA111" },
      });
      // Anonymous: the limiter ran first (onRequest) and passed it, then
      // authenticate turned the caller away. A 401 is therefore proof the
      // request was counted.
      expect(res.statusCode).toBe(401);
    }

    const limited = await app.inject({
      method: "POST",
      url: "/groups/join",
      remoteAddress,
      payload: { code: "AAA111" },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expectStandardRateLimitBody(limited);

    // Minting a new session does not widen the search: the bucket is the
    // address, not the freely-rotatable token.
    const rotated = await app.inject({
      method: "POST",
      url: "/groups/join",
      remoteAddress,
      headers: authHeader("user_2", "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      payload: { code: "ZZZ999" },
    });
    expect(rotated.statusCode).toBe(429);

    const neighbour = await app.inject({
      method: "POST",
      url: "/groups/join",
      remoteAddress: "203.0.113.22",
      payload: { code: "AAA111" },
    });
    expect(neighbour.statusCode).toBe(401);
    expect(neighbour.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    await app.close();
  });
});

describe("webhook registration tier (real app) (#668)", () => {
  const registration = {
    url: "https://example.test/hook",
    events: ["expense.created"],
  };

  it("answers the request that crosses the registration limit with 429, on either door", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().webhookCreate;
    const headers = authHeader();

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks",
        headers,
        payload: registration,
      });
      // 201: the row was written, so the limiter passed it through.
      expect(res.statusCode).toBe(201);
      expect(res.headers["x-ratelimit-limit"]).toBe(String(max));
    }

    const limited = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers,
      payload: registration,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);

    // The group-scoped door carries the same tight budget. It is a separate
    // counter under the default in-memory store — @fastify/rate-limit gives
    // every route that declares its own `config.rateLimit` a child store — so
    // spending it here is what proves the annotation reached the second
    // declaration too, rather than the route silently inheriting the global
    // allowance.
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/groups/group_1/webhooks",
        headers,
        payload: registration,
      });
      expect(res.statusCode).not.toBe(429);
      expect(res.headers["x-ratelimit-limit"]).toBe(String(max));
    }

    const groupDoor = await app.inject({
      method: "POST",
      url: "/groups/group_1/webhooks",
      headers,
      payload: registration,
    });
    expect(groupDoor.statusCode).toBe(429);
    expect(groupDoor.headers["x-ratelimit-remaining"]).toBe("0");
    expectStandardRateLimitBody(groupDoor);

    // A different wallet behind the same address keeps its full allowance.
    const neighbour = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: authHeader("user_2", "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      payload: registration,
    });
    expect(neighbour.statusCode).toBe(201);
    expect(neighbour.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    await app.close();
  });

  it("does not let an anonymous caller spend an account's registration budget", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().webhookCreate;

    // The policy runs on preHandler, after authenticate, so an unauthenticated
    // flood is turned away before it can be counted against anyone.
    for (let i = 0; i < max + 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/webhooks",
        payload: registration,
      });
      expect(res.statusCode).toBe(401);
    }

    const victim = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: authHeader("user_victim", "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
      payload: registration,
    });
    expect(victim.statusCode).toBe(201);
    expect(victim.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    await app.close();
  });
});

describe("receipt upload tier (real app) (#668)", () => {
  const upload = rejectedReceiptUpload();

  it("answers the request that crosses the upload limit with 429", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().uploadReceipt;
    const headers = { ...authHeader(), ...upload.headers };

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/uploads/receipt",
        headers,
        payload: upload.payload,
      });
      // Rejected content type, nothing written to disk: the handler ran, so
      // this was not a limit rejection.
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("BAD_FILE_TYPE");
      expect(res.headers["x-ratelimit-limit"]).toBe(String(max));
    }

    const limited = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers,
      payload: upload.payload,
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    expect(limited.headers["retry-after"]).toBeTruthy();
    expectStandardRateLimitBody(limited);

    // Retrying a lost upload no longer starves the same account's other
    // budgets: webhook registration is a separate bucket.
    const webhook = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: authHeader(),
      payload: { url: "https://example.test/hook", events: ["expense.created"] },
    });
    expect(webhook.statusCode).not.toBe(429);
    expect(webhook.headers["x-ratelimit-limit"]).toBe(
      String(rateLimitPolicies().webhookCreate.max)
    );

    await app.close();
  });

  it("does not let an anonymous flood starve a signed-in account's upload budget", async () => {
    const app = await buildApp();
    const { max } = rateLimitPolicies().uploadReceipt;

    for (let i = 0; i < max + 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/uploads/receipt",
        headers: upload.headers,
        payload: upload.payload,
      });
      expect(res.statusCode).toBe(401);
    }

    const victim = await app.inject({
      method: "POST",
      url: "/uploads/receipt",
      headers: {
        ...authHeader("user_victim", "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
        ...upload.headers,
      },
      payload: upload.payload,
    });
    expect(victim.statusCode).toBe(400);
    expect(victim.headers["x-ratelimit-remaining"]).toBe(String(max - 1));

    await app.close();
  });
});
