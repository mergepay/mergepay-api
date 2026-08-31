/**
 * Rate-limit response headers and the tiers added for #263.
 *
 * Like tests/rate-limit-policies.test.ts, behaviour is exercised against small
 * self-contained Fastify instances wired the way `rateLimited()` wires a real
 * route: `buildApp()` skips rate limiting under NODE_ENV=test, so asserting
 * 429s through it would prove nothing. Nothing here reads the real clock.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  policyKeyGenerator,
  rateLimitPolicies,
  rateLimited,
  type RateLimitPolicyName,
} from "../src/lib/rate-limit";

/** The header set the API promises callers, lowercased as Fastify returns them. */
const LIMIT_HEADER = "ratelimit-limit";
const REMAINING_HEADER = "ratelimit-remaining";
const RESET_HEADER = "ratelimit-reset";
const RETRY_AFTER_HEADER = "retry-after";

/**
 * An app registered the way src/plugins/rate-limit.ts registers the real one:
 * draft-spec headers on, global bucket keyed by the global policy.
 */
async function appWithHeaders(max: number, timeWindow = 60_000) {
  const app = Fastify();
  await app.register(rateLimit, {
    global: true,
    max,
    timeWindow,
    keyGenerator: policyKeyGenerator(rateLimitPolicies().global),
    enableDraftSpec: true,
    addHeaders: {
      [LIMIT_HEADER]: true,
      [REMAINING_HEADER]: true,
      [RESET_HEADER]: true,
      [RETRY_AFTER_HEADER]: true,
    },
  });
  app.get("/thing", async () => ({ ok: true }));
  return app;
}

/** An app whose single route carries one named policy. */
async function appWithPolicy(name: Exclude<RateLimitPolicyName, "global">) {
  const app = Fastify();
  await app.register(rateLimit, {
    global: false,
    enableDraftSpec: true,
    addHeaders: {
      [LIMIT_HEADER]: true,
      [REMAINING_HEADER]: true,
      [RESET_HEADER]: true,
      [RETRY_AFTER_HEADER]: true,
    },
  });
  app.post("/thing", rateLimited(name), async () => ({ ok: true }));
  return app;
}

function get(app: any, ip = "203.0.113.5") {
  return app.inject({ method: "GET", url: "/thing", remoteAddress: ip });
}

function post(app: any, ip = "203.0.113.5") {
  return app.inject({ method: "POST", url: "/thing", remoteAddress: ip });
}

describe("rate-limit headers", () => {
  it("reports the budget on a successful response", async () => {
    const app = await appWithHeaders(5);
    const res = await get(app);

    expect(res.statusCode).toBe(200);
    expect(Number(res.headers[LIMIT_HEADER])).toBe(5);
    expect(res.headers[RESET_HEADER]).toBeDefined();
    await app.close();
  });

  it("counts remaining requests down as the budget is spent", async () => {
    const app = await appWithHeaders(3);

    const first = await get(app);
    const second = await get(app);

    expect(Number(first.headers[REMAINING_HEADER])).toBe(2);
    expect(Number(second.headers[REMAINING_HEADER])).toBe(1);
    await app.close();
  });

  it("returns Retry-After once the budget is exhausted", async () => {
    const app = await appWithHeaders(1);

    await get(app);
    const limited = await get(app);

    expect(limited.statusCode).toBe(429);
    expect(limited.headers[RETRY_AFTER_HEADER]).toBeDefined();
    expect(Number(limited.headers[REMAINING_HEADER])).toBe(0);
    await app.close();
  });

  it("does not send Retry-After while the caller is still within budget", async () => {
    const app = await appWithHeaders(5);
    const res = await get(app);

    expect(res.statusCode).toBe(200);
    expect(res.headers[RETRY_AFTER_HEADER]).toBeUndefined();
    await app.close();
  });
});

describe("rate limiting rejects bursts and admits normal traffic", () => {
  it("admits a request volume inside the configured limit", async () => {
    const app = await appWithHeaders(10);

    const results = [];
    for (let i = 0; i < 10; i++) results.push(await get(app));

    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    await app.close();
  });

  it("rejects the request that crosses the limit with 429", async () => {
    const app = await appWithHeaders(10);

    for (let i = 0; i < 10; i++) await get(app);
    const eleventh = await get(app);

    expect(eleventh.statusCode).toBe(429);
    await app.close();
  });

  it("keeps separate callers on separate budgets", async () => {
    const app = await appWithHeaders(1);

    await get(app, "203.0.113.5");
    const sameCaller = await get(app, "203.0.113.5");
    const otherCaller = await get(app, "198.51.100.7");

    expect(sameCaller.statusCode).toBe(429);
    // One caller exhausting its budget must not lock anyone else out.
    expect(otherCaller.statusCode).toBe(200);
    await app.close();
  });
});

describe("per-route tiers", () => {
  it("limits auth challenge to its own tight budget", async () => {
    const { max } = rateLimitPolicies().authChallenge;
    const app = await appWithPolicy("authChallenge");

    for (let i = 0; i < max; i++) {
      expect((await post(app)).statusCode).toBe(200);
    }
    expect((await post(app)).statusCode).toBe(429);
    await app.close();
  });

  it("limits treasury proposal creation", async () => {
    const { max } = rateLimitPolicies().treasuryPropose;
    const app = await appWithPolicy("treasuryPropose");

    for (let i = 0; i < max; i++) {
      expect((await post(app)).statusCode).toBe(200);
    }
    expect((await post(app)).statusCode).toBe(429);
    await app.close();
  });

  it("gives proposal creation its own bucket, separate from submission", async () => {
    const policies = rateLimitPolicies();
    expect(policies.treasuryPropose.prefix).not.toBe(policies.treasurySubmit.prefix);
  });

  it("budgets proposal creation below the global default", async () => {
    const policies = rateLimitPolicies();
    expect(policies.treasuryPropose.max).toBeLessThan(policies.global.max);
  });

  it("keys proposal creation by user so one member cannot exhaust the group's budget", () => {
    expect(rateLimitPolicies().treasuryPropose.keyBy).toBe("user-or-ip");
  });

  it("runs proposal creation on preHandler so the user is resolved first", () => {
    // A `user-or-ip` policy on onRequest would key every request by IP,
    // because req.user is not populated until the authenticate hook runs.
    expect(rateLimitPolicies().treasuryPropose.hook).toBe("preHandler");
  });
});

describe("global bucket keying", () => {
  it("keys the global limit by the same identity as the named policies", () => {
    const global = rateLimitPolicies().global;
    expect(global.keyBy).toBe("user-or-ip");
    // Two requests from one authenticated user share a budget across IPs.
    const keyFor = policyKeyGenerator(global);
    const fromOffice = keyFor({ ip: "203.0.113.5", user: { id: "user_1" } } as any);
    const fromHome = keyFor({ ip: "198.51.100.7", user: { id: "user_1" } } as any);
    expect(fromOffice).toBe(fromHome);
  });

  it("falls back to the client IP when there is no authenticated user", () => {
    const keyFor = policyKeyGenerator(rateLimitPolicies().global);
    const anonymous = keyFor({ ip: "203.0.113.5", user: undefined } as any);
    const otherAnonymous = keyFor({ ip: "198.51.100.7", user: undefined } as any);
    expect(anonymous).not.toBe(otherAnonymous);
  });
});
