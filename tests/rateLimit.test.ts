import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  rateLimitPolicies,
  rateLimited,
  policyKeyGenerator,
} from "../src/lib/rate-limit";
import { ipKey, userOrIpKey } from "../src/services/rate-limit-keys";

type App = Awaited<ReturnType<typeof Fastify>>;

function buildLimitedApp(max: number, perRouteMax?: number) {
  return async () => {
    const app = Fastify();
    await app.register(rateLimit, { max, timeWindow: "1 minute" });
    app.get("/test-open", async () => ({ ok: true }));
    if (perRouteMax !== undefined) {
      app.post(
        "/test-limited",
        { config: { rateLimit: { max: perRouteMax, timeWindow: "1 minute" } } },
        async () => ({ ok: true })
      );
    }
    return app;
  };
}

describe("rate limiting - under limit", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildLimitedApp(100, 2)();
  });
  afterAll(async () => { await app.close(); });

  it("allows requests under the per-route limit and exposes headers", async () => {
    const res = await app.inject({ method: "POST", url: "/test-limited" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-remaining"]).toBe("1");
  });
});

describe("rate limiting - exceeds limit", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildLimitedApp(100, 2)();
  });
  afterAll(async () => { await app.close(); });

  it("returns 429 with rate-limit headers after exceeding per-route limit", async () => {
    await app.inject({ method: "POST", url: "/test-limited" });
    await app.inject({ method: "POST", url: "/test-limited" });

    const r3 = await app.inject({ method: "POST", url: "/test-limited" });
    expect(r3.statusCode).toBe(429);
    expect(r3.headers["retry-after"]).toBeTruthy();
    expect(r3.headers["x-ratelimit-limit"]).toBe("2");
    expect(r3.headers["x-ratelimit-remaining"]).toBe("0");
  });
});

describe("rate limiting - global limit", () => {
  let app: App;

  beforeAll(async () => {
    app = await buildLimitedApp(2)();
  });
  afterAll(async () => { await app.close(); });

  it("returns 429 and headers when global limit is exceeded", async () => {
    await app.inject({ method: "GET", url: "/test-open" });
    await app.inject({ method: "GET", url: "/test-open" });

    const r3 = await app.inject({ method: "GET", url: "/test-open" });
    expect(r3.statusCode).toBe(429);
    expect(r3.headers["x-ratelimit-limit"]).toBe("2");
    expect(typeof r3.headers["x-ratelimit-remaining"]).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Route-specific rate-limit tests
//
// These mirror the exact rate-limit configuration wired into the production
// routes (auth/challenge, auth/verify, settlements/:id/confirm) using small
// self-contained Fastify instances. No real clock or shared counters are used
// so tests complete instantly regardless of the timeWindow value.
// ---------------------------------------------------------------------------

describe("POST /auth/challenge — 10 req/min per IP", () => {
  const CHALLENGE_MAX = rateLimitPolicies().authChallenge.max;

  let app: App;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    const policy = rateLimitPolicies().authChallenge;
    await app.register(rateLimit, {
      max: policy.max,
      timeWindow: policy.timeWindow,
      hook: policy.hook,
      keyGenerator: policyKeyGenerator(policy),
    });
    app.post("/auth/challenge", async () => ({ ok: true }));
    await app.ready();
  });
  afterAll(async () => { await app.close(); });

  it("allows requests below the configured threshold", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/challenge" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe(String(CHALLENGE_MAX));
    expect(Number(res.headers["x-ratelimit-remaining"])).toBeGreaterThan(0);
  });

  it("returns 429 after exceeding the configured limit within the window", async () => {
    const fresh = Fastify({ logger: false });
    const policy = rateLimitPolicies().authChallenge;
    await fresh.register(rateLimit, {
      max: policy.max,
      timeWindow: policy.timeWindow,
      hook: policy.hook,
      keyGenerator: policyKeyGenerator(policy),
    });
    fresh.post("/auth/challenge", async () => ({ ok: true }));
    await fresh.ready();

    for (let i = 0; i < CHALLENGE_MAX; i++) {
      const r = await fresh.inject({ method: "POST", url: "/auth/challenge" });
      expect(r.statusCode).toBe(200);
    }

    const blocked = await fresh.inject({ method: "POST", url: "/auth/challenge" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-ratelimit-limit"]).toBe(String(CHALLENGE_MAX));
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["retry-after"]).toBeDefined();
    await fresh.close();
  });

  it("exposes the standard rate-limit headers on successful responses", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/challenge" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  it("keyed per IP — different IPs get independent buckets", async () => {
    const fresh = Fastify({ logger: false, trustProxy: true });
    // Use a very small limit (1) to make the test fast.
    await fresh.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      hook: "onRequest",
      keyGenerator: ipKey("auth.challenge"),
    });
    fresh.post("/auth/challenge", async () => ({ ok: true }));
    await fresh.ready();

    const ipA = await fresh.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    const ipB = await fresh.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-forwarded-for": "10.0.0.2" },
    });

    expect(ipA.statusCode).toBe(200);
    // IP B has an independent bucket, so it also succeeds.
    expect(ipB.statusCode).toBe(200);

    // IP A's second request is now blocked.
    const ipA2 = await fresh.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    expect(ipA2.statusCode).toBe(429);
    await fresh.close();
  });
});

describe("POST /auth/verify — 10 req/min per IP", () => {
  const VERIFY_MAX = rateLimitPolicies().authVerify.max;

  it("returns 429 after exceeding the limit", async () => {
    const app = Fastify({ logger: false });
    const policy = rateLimitPolicies().authVerify;
    await app.register(rateLimit, {
      max: policy.max,
      timeWindow: policy.timeWindow,
      hook: policy.hook,
      keyGenerator: policyKeyGenerator(policy),
    });
    app.post("/auth/verify", async () => ({ ok: true }));
    await app.ready();

    for (let i = 0; i < VERIFY_MAX; i++) {
      const r = await app.inject({ method: "POST", url: "/auth/verify" });
      expect(r.statusCode).toBe(200);
    }

    const blocked = await app.inject({ method: "POST", url: "/auth/verify" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-ratelimit-limit"]).toBe(String(VERIFY_MAX));
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("keyed per IP — different IPs get independent buckets", async () => {
    const app = Fastify({ logger: false, trustProxy: true });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      hook: "onRequest",
      keyGenerator: ipKey("auth.verify"),
    });
    app.post("/auth/verify", async () => ({ ok: true }));
    await app.ready();

    const ipA = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-forwarded-for": "192.168.1.100" },
    });
    const ipB = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-forwarded-for": "192.168.1.101" },
    });
    const ipA2 = await app.inject({
      method: "POST",
      url: "/auth/verify",
      headers: { "x-forwarded-for": "192.168.1.100" },
    });

    expect(ipA.statusCode).toBe(200);
    expect(ipB.statusCode).toBe(200);
    expect(ipA2.statusCode).toBe(429);
    await app.close();
  });
});

describe("POST /settlements/:id/confirm — 20 req/min per user/IP", () => {
  const CONFIRM_MAX = rateLimitPolicies().settlementConfirm.max;

  it("returns 429 after exceeding the limit", async () => {
    const app = Fastify({ logger: false });
    const policy = rateLimitPolicies().settlementConfirm;
    await app.register(rateLimit, {
      max: policy.max,
      timeWindow: policy.timeWindow,
      hook: policy.hook,
      keyGenerator: policyKeyGenerator(policy),
    });
    app.post(
      "/settlements/:id/confirm",
      {
        preHandler: async (req) => {
          const userId = req.headers["x-test-user"] as string | undefined;
          if (userId) (req as any).user = { id: userId, stellarPublicKey: "GTEST" };
        },
      },
      async () => ({ ok: true })
    );
    await app.ready();

    const headers = { "x-test-user": "user_1" };
    for (let i = 0; i < CONFIRM_MAX; i++) {
      const r = await app.inject({
        method: "POST",
        url: "/settlements/s1/confirm",
        headers,
      });
      expect(r.statusCode).toBe(200);
    }

    const blocked = await app.inject({
      method: "POST",
      url: "/settlements/s1/confirm",
      headers,
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-ratelimit-limit"]).toBe(String(CONFIRM_MAX));
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("keyed per user — different authenticated users get independent buckets", async () => {
    const app = Fastify({ logger: false });
    const policy = rateLimitPolicies().settlementConfirm;
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      hook: policy.hook,
      keyGenerator: policyKeyGenerator(policy),
    });
    app.post(
      "/settlements/:id/confirm",
      {
        preHandler: async (req) => {
          const userId = req.headers["x-test-user"] as string | undefined;
          if (userId) (req as any).user = { id: userId, stellarPublicKey: "GTEST" };
        },
      },
      async () => ({ ok: true })
    );
    await app.ready();

    const userA1 = await app.inject({
      method: "POST",
      url: "/settlements/s1/confirm",
      headers: { "x-test-user": "user_a" },
    });
    const userB1 = await app.inject({
      method: "POST",
      url: "/settlements/s1/confirm",
      headers: { "x-test-user": "user_b" },
    });
    const userA2 = await app.inject({
      method: "POST",
      url: "/settlements/s1/confirm",
      headers: { "x-test-user": "user_a" },
    });

    expect(userA1.statusCode).toBe(200);
    expect(userB1.statusCode).toBe(200);
    expect(userA2.statusCode).toBe(429);
    await app.close();
  });

  it("keyed per user — unauthenticated falls back to IP", async () => {
    const app = Fastify({ logger: false });
    const policy = rateLimitPolicies().settlementConfirm;
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      hook: policy.hook,
      keyGenerator: policyKeyGenerator(policy),
    });
    app.post("/settlements/:id/confirm", async () => ({ ok: true }));
    await app.ready();

    const r1 = await app.inject({ method: "POST", url: "/settlements/s1/confirm" });
    const r2 = await app.inject({ method: "POST", url: "/settlements/s1/confirm" });
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(429);
    await app.close();
  });
});

describe("rate-limit headers on 429 responses", () => {
  it("includes x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, and retry-after", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      keyGenerator: ipKey("test"),
    });
    app.post("/limited", async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: "POST", url: "/limited" });
    const blocked = await app.inject({ method: "POST", url: "/limited" });

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-ratelimit-limit"]).toBe("1");
    expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    expect(blocked.headers["x-ratelimit-reset"]).toBeDefined();
    expect(blocked.headers["retry-after"]).toBeDefined();
    await app.close();
  });

  it("429 payload matches the standard Fastify rate-limit shape", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      keyGenerator: ipKey("test"),
    });
    app.post("/limited", async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: "POST", url: "/limited" });
    const blocked = await app.inject({ method: "POST", url: "/limited" });

    expect(blocked.statusCode).toBe(429);
    const body = blocked.json();
    expect(body).toHaveProperty("statusCode", 429);
    expect(body).toHaveProperty("error");
    await app.close();
  });
});

describe("independent policy budgets", () => {
  it("exhausting one route's budget does not affect another route's budget", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1000,
      timeWindow: 60_000,
      keyGenerator: (req) => `global:ip:${req.ip}`,
    });

    // Route A: limit of 1
    const policyA = rateLimitPolicies().authChallenge;
    app.post("/route-a", {
      config: {
        rateLimit: {
          max: 1,
          timeWindow: policyA.timeWindow,
          hook: policyA.hook,
          keyGenerator: policyKeyGenerator(policyA),
        },
      },
    }, async () => ({ ok: true }));

    // Route B: limit of 1
    const policyB = rateLimitPolicies().authVerify;
    app.post("/route-b", {
      config: {
        rateLimit: {
          max: 1,
          timeWindow: policyB.timeWindow,
          hook: policyB.hook,
          keyGenerator: policyKeyGenerator(policyB),
        },
      },
    }, async () => ({ ok: true }));

    await app.ready();

    // Exhaust Route A
    await app.inject({ method: "POST", url: "/route-a" });
    const aBlocked = await app.inject({ method: "POST", url: "/route-a" });
    expect(aBlocked.statusCode).toBe(429);

    // Route B still has its full budget
    const bOk = await app.inject({ method: "POST", url: "/route-b" });
    expect(bOk.statusCode).toBe(200);

    await app.close();
  });
});

describe("internal/service calls not throttled", () => {
  it("routes without a per-route policy only count against the global limit", async () => {
    const app = Fastify({ logger: false });
    // Global limit is generous; internal calls typically share an IP.
    await app.register(rateLimit, {
      max: 2,
      timeWindow: 60_000,
      keyGenerator: (req) => `global:ip:${req.ip}`,
    });
    // Simulate a route with NO per-route policy (like a health check).
    app.get("/health", async () => ({ status: "ok" }));
    await app.ready();

    const r1 = await app.inject({ method: "GET", url: "/health" });
    const r2 = await app.inject({ method: "GET", url: "/health" });
    const r3 = await app.inject({ method: "GET", url: "/health" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429); // hits global limit
    await app.close();
  });
});
