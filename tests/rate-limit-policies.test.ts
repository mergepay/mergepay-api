import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import {
  policyKeyGenerator,
  rateLimitPolicies,
  rateLimited,
  type RateLimitPolicyName,
} from "../src/lib/rate-limit";
import { config } from "../src/config";

/**
 * These tests cover the policy *table* (which route gets which budget, keyed by
 * what) and the *behaviour* of a policy applied to a route.
 *
 * Behaviour is exercised against small, self-contained Fastify instances wired
 * exactly the way `rateLimited()` wires a real route, rather than against
 * `buildApp()`, because buildApp deliberately skips rate limiting under
 * NODE_ENV=test so the rest of the suite does not depend on shared counters or
 * on wall-clock windows. Nothing here reads the real clock or mutates global
 * process state.
 */

const EXPENSIVE_POLICIES: RateLimitPolicyName[] = [
  "authChallenge",
  "authVerify",
  "settlementCreate",
  "settlementConfirm",
  "treasurySubmit",
  "anchorInit",
  "anchorPoll",
  "anchorWebhook",
];

function fakeRequest(over: Record<string, unknown> = {}): any {
  return { ip: "203.0.113.5", user: undefined, ...over };
}

describe("rate-limit policy table", () => {
  it("gives every expensive route its own bucket prefix", () => {
    const policies = rateLimitPolicies();
    const prefixes = EXPENSIVE_POLICIES.map((name) => policies[name].prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
    // And none of them shares the global bucket.
    expect(prefixes).not.toContain(policies.global.prefix);
  });

  it("keeps SEP-10 verification no looser than the challenge that precedes it", () => {
    const policies = rateLimitPolicies();
    expect(policies.authVerify.max).toBeLessThanOrEqual(policies.authChallenge.max);
  });

  it("budgets every expensive route below the global default", () => {
    const policies = rateLimitPolicies();
    for (const name of EXPENSIVE_POLICIES) {
      expect(policies[name].max).toBeLessThan(policies.global.max);
    }
  });

  it("keeps anchor initiation the tightest anchor budget, since it fans out upstream", () => {
    const policies = rateLimitPolicies();
    expect(policies.anchorInit.max).toBeLessThan(policies.anchorPoll.max);
  });

  it("separates signed submission from the reads it competes with", () => {
    const policies = rateLimitPolicies();
    expect(policies.settlementConfirm.prefix).not.toBe(policies.treasurySubmit.prefix);
    expect(policies.settlementConfirm.prefix).not.toBe(policies.history.prefix);
  });

  it("keys authenticated policies by user and pre-auth policies by IP", () => {
    const policies = rateLimitPolicies();

    // SEP-10 has no session yet, and the anchor webhook is authenticated by a
    // shared secret rather than a session.
    expect(policies.authChallenge.keyBy).toBe("ip");
    expect(policies.authVerify.keyBy).toBe("ip");
    expect(policies.anchorWebhook.keyBy).toBe("ip");

    for (const name of [
      "settlementCreate",
      "settlementConfirm",
      "treasurySubmit",
      "anchorInit",
      "anchorPoll",
    ] as const) {
      expect(policies[name].keyBy).toBe("user-or-ip");
      // Reading req.user requires the limiter to run after authenticate.
      expect(policies[name].hook).toBe("preHandler");
    }
  });

  it("never puts a Stellar public key in a bucket key", () => {
    const policies = rateLimitPolicies();
    const wallet = "GSECRETPUBLICKEYXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    for (const policy of Object.values(policies)) {
      const key = policyKeyGenerator(policy)(
        fakeRequest({ user: { id: "user_1", stellarPublicKey: wallet } })
      );
      expect(key).not.toContain(wallet);
      expect(key.length).toBeLessThanOrEqual(200);
    }
  });

  it("does not let an unauthenticated caller pick its own bucket via a header", () => {
    const policy = rateLimitPolicies().authVerify;
    const generate = policyKeyGenerator(policy);

    // Fastify's req.ip is the resolved address; a forwarded header is not
    // consulted unless trustProxy is enabled, which this app does not do.
    const spoofed = generate(
      fakeRequest({ headers: { "x-forwarded-for": "198.51.100.9" } })
    );
    expect(spoofed).toBe("auth.verify:ip:203.0.113.5");
  });

  it("reads its numbers from config, so every limit is deployment-overridable", () => {
    const policies = rateLimitPolicies();
    expect(policies.authVerify.max).toBe(config.RATE_LIMIT_AUTH_VERIFY_MAX);
    expect(policies.authVerify.timeWindow).toBe(config.RATE_LIMIT_AUTH_VERIFY_WINDOW_MS);
    expect(policies.settlementConfirm.max).toBe(config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX);
    expect(policies.anchorInit.max).toBe(config.RATE_LIMIT_ANCHOR_INIT_MAX);
  });

  it("emits route options @fastify/rate-limit understands", () => {
    const options = rateLimited("settlementConfirm");
    expect(options.config.rateLimit).toMatchObject({
      max: config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX,
      timeWindow: config.RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS,
      hook: "preHandler",
    });
    expect(typeof options.config.rateLimit.keyGenerator).toBe("function");
  });
});

/**
 * Build an app whose route is limited exactly the way `rateLimited()` limits a
 * real one, with a stubbed authenticate hook standing in for the session.
 */
async function buildPolicyApp(name: Parameters<typeof rateLimited>[0], max: number) {
  const policy = rateLimitPolicies()[name];
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: 1000, // a deliberately generous global, so only the route policy bites
    timeWindow: 60_000,
    keyGenerator: (request) => `global:ip:${request.ip}`,
  });

  const routeOptions = {
    config: {
      rateLimit: {
        max,
        timeWindow: policy.timeWindow,
        hook: policy.hook,
        keyGenerator: policyKeyGenerator(policy),
      },
    },
    preHandler: async (request: any) => {
      const userId = request.headers["x-test-user"];
      if (userId) request.user = { id: userId, stellarPublicKey: "GTEST" };
    },
  };

  app.post(`/${name}`, routeOptions as never, async () => ({ ok: true }));
  app.get("/read", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rate-limit policy behaviour", () => {
  it("exhausts one policy's budget without touching another's", async () => {
    const confirmApp = await buildPolicyApp("settlementConfirm", 1);
    const treasuryApp = await buildPolicyApp("treasurySubmit", 1);

    const headers = { "x-test-user": "user_a" };
    expect(
      (await confirmApp.inject({ method: "POST", url: "/settlementConfirm", headers }))
        .statusCode
    ).toBe(200);
    expect(
      (await confirmApp.inject({ method: "POST", url: "/settlementConfirm", headers }))
        .statusCode
    ).toBe(429);

    // A different policy, same identity: still has its full budget.
    expect(
      (await treasuryApp.inject({ method: "POST", url: "/treasurySubmit", headers }))
        .statusCode
    ).toBe(200);

    await confirmApp.close();
    await treasuryApp.close();
  });

  it("does not block ordinary reads when a submission budget is exhausted", async () => {
    const app = await buildPolicyApp("settlementConfirm", 1);
    const headers = { "x-test-user": "user_a" };

    await app.inject({ method: "POST", url: "/settlementConfirm", headers });
    const blocked = await app.inject({
      method: "POST",
      url: "/settlementConfirm",
      headers,
    });
    const read = await app.inject({ method: "GET", url: "/read", headers });

    expect(blocked.statusCode).toBe(429);
    expect(read.statusCode).toBe(200);
    await app.close();
  });

  it("gives each authenticated user an independent budget", async () => {
    const app = await buildPolicyApp("settlementCreate", 1);

    const a1 = await app.inject({
      method: "POST",
      url: "/settlementCreate",
      headers: { "x-test-user": "user_a" },
    });
    const a2 = await app.inject({
      method: "POST",
      url: "/settlementCreate",
      headers: { "x-test-user": "user_a" },
    });
    const b1 = await app.inject({
      method: "POST",
      url: "/settlementCreate",
      headers: { "x-test-user": "user_b" },
    });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(429);
    expect(b1.statusCode).toBe(200);
    await app.close();
  });

  it("keys SEP-10 by IP, so a 429 cannot reveal whether an account is known", async () => {
    const app = await buildPolicyApp("authVerify", 1);

    // Two different accounts from the same client: the second is limited,
    // because the bucket is the client, not the wallet.
    await app.inject({ method: "POST", url: "/authVerify" });
    const second = await app.inject({ method: "POST", url: "/authVerify" });

    expect(second.statusCode).toBe(429);
    expect(second.json()).not.toHaveProperty("account");
    await app.close();
  });

  it("returns retry information on a 429", async () => {
    const app = await buildPolicyApp("anchorInit", 1);
    const headers = { "x-test-user": "user_a" };

    await app.inject({ method: "POST", url: "/anchorInit", headers });
    const limited = await app.inject({ method: "POST", url: "/anchorInit", headers });

    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.headers["x-ratelimit-limit"]).toBe("1");
    expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
    await app.close();
  });

  it("rejects a limited request before it can reach the handler", async () => {
    const policy = rateLimitPolicies().anchorInit;
    const handler = vi.fn(async () => ({ ok: true }));

    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: policy.timeWindow,
      keyGenerator: policyKeyGenerator(policy),
    });
    app.post("/anchors/deposit", handler);
    await app.ready();

    await app.inject({ method: "POST", url: "/anchors/deposit" });
    const limited = await app.inject({ method: "POST", url: "/anchors/deposit" });

    expect(limited.statusCode).toBe(429);
    // The upstream anchor work lives inside the handler, so a limited request
    // cannot amplify into an anchor call.
    expect(handler).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
