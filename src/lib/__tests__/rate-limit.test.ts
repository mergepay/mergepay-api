/**
 * Unit tests for rate-limit policy configuration — Issue #1142.
 *
 * Verifies that authentication and SEP-10 endpoints are covered by named
 * rate-limit policies, that each policy is keyed by IP (never by user, since
 * the caller is unauthenticated at that stage), that the policies return
 * sensible defaults, and that `rateLimited()` produces Fastify-compatible
 * config objects with the right shape.
 */
import { describe, it, expect } from "vitest";
import {
  rateLimitPolicies,
  rateLimited,
  isGlobalRateLimitExempt,
} from "../rate-limit";

describe("rateLimitPolicies — auth endpoint policies exist", () => {
  it("defines an authChallenge policy", () => {
    const policies = rateLimitPolicies();
    expect(policies).toHaveProperty("authChallenge");
  });

  it("defines an authVerify policy", () => {
    const policies = rateLimitPolicies();
    expect(policies).toHaveProperty("authVerify");
  });

  it("defines an authLogout policy", () => {
    const policies = rateLimitPolicies();
    expect(policies).toHaveProperty("authLogout");
  });
});

describe("rateLimitPolicies — authChallenge policy shape", () => {
  it("is keyed by IP, not by user (pre-auth endpoint)", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.keyBy).toBe("ip");
  });

  it("runs on onRequest hook so it fires before any handler logic", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.hook).toBe("onRequest");
  });

  it("has a positive max request count", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.max).toBeGreaterThan(0);
  });

  it("has a positive time window", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.timeWindow).toBeGreaterThan(0);
  });

  it("has a unique non-empty prefix", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.prefix.length).toBeGreaterThan(0);
  });

  it("defaults to max=20 requests per window", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.max).toBe(20);
  });

  it("defaults to a 60-second window", () => {
    const { authChallenge } = rateLimitPolicies();
    expect(authChallenge.timeWindow).toBe(60000);
  });
});

describe("rateLimitPolicies — authVerify policy shape", () => {
  it("is keyed by IP (pre-auth endpoint)", () => {
    const { authVerify } = rateLimitPolicies();
    expect(authVerify.keyBy).toBe("ip");
  });

  it("runs on onRequest hook", () => {
    const { authVerify } = rateLimitPolicies();
    expect(authVerify.hook).toBe("onRequest");
  });

  it("defaults to max=10 requests per window (tighter than challenge)", () => {
    const { authVerify } = rateLimitPolicies();
    expect(authVerify.max).toBe(10);
  });

  it("defaults to a 60-second window", () => {
    const { authVerify } = rateLimitPolicies();
    expect(authVerify.timeWindow).toBe(60000);
  });

  it("has a prefix distinct from authChallenge", () => {
    const policies = rateLimitPolicies();
    expect(policies.authVerify.prefix).not.toBe(policies.authChallenge.prefix);
  });
});

describe("rateLimitPolicies — authLogout policy shape", () => {
  it("is keyed by IP (logout answers ok for invalid tokens)", () => {
    const { authLogout } = rateLimitPolicies();
    expect(authLogout.keyBy).toBe("ip");
  });

  it("runs on onRequest hook", () => {
    const { authLogout } = rateLimitPolicies();
    expect(authLogout.hook).toBe("onRequest");
  });

  it("has a positive max and time window", () => {
    const { authLogout } = rateLimitPolicies();
    expect(authLogout.max).toBeGreaterThan(0);
    expect(authLogout.timeWindow).toBeGreaterThan(0);
  });

  it("has a prefix distinct from authChallenge and authVerify", () => {
    const policies = rateLimitPolicies();
    expect(policies.authLogout.prefix).not.toBe(policies.authChallenge.prefix);
    expect(policies.authLogout.prefix).not.toBe(policies.authVerify.prefix);
  });
});

describe("rateLimitPolicies — all policies have unique prefixes", () => {
  it("no two policies share the same prefix", () => {
    const policies = rateLimitPolicies();
    const prefixes = Object.values(policies).map((p) => p.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});

describe("rateLimited — Fastify route config shape", () => {
  it("returns a config object with a rateLimit sub-object", () => {
    const opts = rateLimited("authChallenge");
    expect(opts).toHaveProperty("config");
    expect(opts.config).toHaveProperty("rateLimit");
  });

  it("rateLimit.max matches the policy's max", () => {
    const opts = rateLimited("authChallenge");
    const policy = rateLimitPolicies().authChallenge;
    expect(opts.config.rateLimit.max).toBe(policy.max);
  });

  it("rateLimit.timeWindow matches the policy's timeWindow", () => {
    const opts = rateLimited("authVerify");
    const policy = rateLimitPolicies().authVerify;
    expect(opts.config.rateLimit.timeWindow).toBe(policy.timeWindow);
  });

  it("rateLimit.hook matches the policy's hook", () => {
    const opts = rateLimited("authLogout");
    const policy = rateLimitPolicies().authLogout;
    expect(opts.config.rateLimit.hook).toBe(policy.hook);
  });

  it("includes a keyGenerator function", () => {
    const opts = rateLimited("authChallenge");
    expect(typeof opts.config.rateLimit.keyGenerator).toBe("function");
  });

  it("includes rateLimitPolicy name for audit/wiring verification", () => {
    const opts = rateLimited("authVerify");
    expect(opts.config).toHaveProperty("rateLimitPolicy", "authVerify");
  });

  it("produces valid config for each auth policy name", () => {
    const authPolicies = ["authChallenge", "authVerify", "authLogout"] as const;

    for (const name of authPolicies) {
      const opts = rateLimited(name);
      expect(opts.config.rateLimit.max).toBeGreaterThan(0);
      expect(opts.config.rateLimit.timeWindow).toBeGreaterThan(0);
    }
  });
});

describe("isGlobalRateLimitExempt — health and docs routes bypass global limit", () => {
  it("exempts /health", () => {
    expect(isGlobalRateLimitExempt({ url: "/health" })).toBe(true);
  });

  it("exempts /health/live", () => {
    expect(isGlobalRateLimitExempt({ url: "/health/live" })).toBe(true);
  });

  it("exempts /docs", () => {
    expect(isGlobalRateLimitExempt({ url: "/docs" })).toBe(true);
  });

  it("exempts /docs/swagger.json", () => {
    expect(isGlobalRateLimitExempt({ url: "/docs/swagger.json" })).toBe(true);
  });

  it("does not exempt /auth/challenge", () => {
    expect(isGlobalRateLimitExempt({ url: "/auth/challenge" })).toBe(false);
  });

  it("does not exempt /sep10/challenge", () => {
    expect(isGlobalRateLimitExempt({ url: "/sep10/challenge" })).toBe(false);
  });

  it("strips query string before checking the path", () => {
    expect(isGlobalRateLimitExempt({ url: "/health?probe=1" })).toBe(true);
    expect(isGlobalRateLimitExempt({ url: "/auth/verify?foo=bar" })).toBe(false);
  });
});
