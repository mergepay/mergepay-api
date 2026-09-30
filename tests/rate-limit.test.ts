import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { signToken } from "../src/plugins/auth";
import {
  globalRateLimitKey,
  authenticatedOrIpKey,
  RATE_LIMIT_TIERS,
} from "../src/plugins/rate-limit";
import { AppError, ErrorCode } from "../src/lib/errors";

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
  afterAll(async () => {
    await app.close();
  });

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
  afterAll(async () => {
    await app.close();
  });

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
  afterAll(async () => {
    await app.close();
  });

  it("returns 429 and headers when global limit is exceeded", async () => {
    await app.inject({ method: "GET", url: "/test-open" });
    await app.inject({ method: "GET", url: "/test-open" });

    const r3 = await app.inject({ method: "GET", url: "/test-open" });
    expect(r3.statusCode).toBe(429);
    expect(r3.headers["x-ratelimit-limit"]).toBe("2");
    expect(typeof r3.headers["x-ratelimit-remaining"]).toBe("string");
  });
});

describe("Issue #703: Rate Limiting Tiering & Key Generator", () => {
  it("defines distinct rate-limit thresholds for public auth endpoints vs authenticated routes", () => {
    expect(RATE_LIMIT_TIERS.publicAuth.max).toBeDefined();
    expect(RATE_LIMIT_TIERS.authenticated.max).toBeDefined();
    expect(RATE_LIMIT_TIERS.publicAuth.max).toBeLessThan(RATE_LIMIT_TIERS.authenticated.max);
  });

  describe("custom keyGenerator", () => {
    it("identifies user identity from valid JWT authorization header", () => {
      const token = signToken({
        id: "usr_alice",
        stellarPublicKey: "GBBD...stellarKey",
      });

      const req: any = {
        headers: { authorization: `Bearer ${token}` },
        ip: "192.168.1.100",
      };

      const key = globalRateLimitKey(req);
      expect(key).toBe("global:user:usr_alice");
    });

    it("falls back to client IP for anonymous/unauthenticated requests", () => {
      const req: any = {
        headers: {},
        ip: "192.168.1.100",
      };

      const key = globalRateLimitKey(req);
      expect(key).toBe("global:ip:192.168.1.100");
    });

    it("falls back to client IP when bearer token is malformed or invalid", () => {
      const req: any = {
        headers: { authorization: "Bearer invalid.jwt.token" },
        ip: "10.0.0.5",
      };

      const key = globalRateLimitKey(req);
      expect(key).toBe("global:ip:10.0.0.5");
    });

    it("authenticatedOrIpKey prefixes keys correctly for authenticated and unauthenticated callers", () => {
      const keyGen = authenticatedOrIpKey("api.tier");
      const token = signToken({
        id: "usr_bob",
        stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });

      expect(keyGen({ headers: { authorization: `Bearer ${token}` }, ip: "1.2.3.4" } as any)).toBe(
        "api.tier:user:usr_bob"
      );
      expect(keyGen({ headers: {}, ip: "1.2.3.4" } as any)).toBe("api.tier:ip:1.2.3.4");
    });
  });

  describe("Tiered route rate limiting with headers and 429 enforcement", () => {
    let tieredApp: App;

    beforeAll(async () => {
      tieredApp = Fastify();
      await tieredApp.register(rateLimit, {
        global: false,
        addHeaders: {
          "x-ratelimit-limit": true,
          "x-ratelimit-remaining": true,
          "x-ratelimit-reset": true,
          "retry-after": true,
        },
        errorResponseBuilder: () =>
          new AppError(429, ErrorCode.RATE_LIMITED, "Too many requests. Please retry later."),
      });

      // Public auth route with tighter limit (e.g. 2 requests per window)
      tieredApp.post(
        "/api/auth/challenge",
        {
          config: {
            rateLimit: {
              max: 2,
              timeWindow: "1 minute",
              keyGenerator: (req) => `auth.challenge:ip:${req.ip}`,
            },
          },
        },
        async () => ({ ok: true, type: "public_auth" })
      );

      // Authenticated route with higher allowance (e.g. 5 requests per window)
      tieredApp.get(
        "/api/groups",
        {
          config: {
            rateLimit: {
              max: 5,
              timeWindow: "1 minute",
              keyGenerator: authenticatedOrIpKey("groups.list"),
            },
          },
        },
        async (req: any) => ({ ok: true, user: req.headers.authorization ? "auth" : "anon" })
      );
    });

    afterAll(async () => {
      await tieredApp.close();
    });

    it("exposes all rate limit headers on successful responses", async () => {
      const res = await tieredApp.inject({
        method: "POST",
        url: "/api/auth/challenge",
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("2");
      expect(res.headers["x-ratelimit-remaining"]).toBe("1");
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    it("triggers 429 when public auth endpoint exceeds its tight limit", async () => {
      // 1st request -> remaining 1
      // 2nd request -> remaining 0
      await tieredApp.inject({ method: "POST", url: "/api/auth/challenge" });

      // 3rd request -> 429 Too Many Requests
      const limited = await tieredApp.inject({ method: "POST", url: "/api/auth/challenge" });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["x-ratelimit-limit"]).toBe("2");
      expect(limited.headers["x-ratelimit-remaining"]).toBe("0");
      expect(limited.headers["retry-after"]).toBeDefined();
      const body = JSON.parse(limited.payload);
      expect(body.code).toBe("RATE_LIMITED");
    });

    it("allows authenticated routes higher allowances and keys by user identity", async () => {
      const token = signToken({
        id: "usr_tiered_1",
        stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      });
      const authHeaders = { authorization: `Bearer ${token}` };

      // Authenticated route has allowance of 5
      for (let i = 0; i < 5; i++) {
        const res = await tieredApp.inject({
          method: "GET",
          url: "/api/groups",
          headers: authHeaders,
        });
        expect(res.statusCode).toBe(200);
        expect(res.headers["x-ratelimit-limit"]).toBe("5");
      }

      // 6th request exceeds the authenticated limit
      const blocked = await tieredApp.inject({
        method: "GET",
        url: "/api/groups",
        headers: authHeaders,
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    });
  });
});
