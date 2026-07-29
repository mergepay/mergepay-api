import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { userOrIpKey } from "../src/services/rate-limit-keys";
import { PrismaRateLimitStore } from "../src/services/rate-limit-store";

/**
 * These build small, self-contained Fastify instances with a deterministic
 * limiter configuration — mirroring exactly how app.ts wires
 * @fastify/rate-limit for the sensitive routes — rather than exercising the
 * full app, since buildApp() disables rate limiting entirely in test mode
 * (config.isTest) for the rest of the test suite's convenience.
 */
async function buildLimitedApp(opts: { max: number; timeWindow: number }) {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, {
    max: opts.max,
    timeWindow: opts.timeWindow,
    keyGenerator: userOrIpKey("test.route"),
  });
  app.post("/protected", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("rate limiting — allowed and rejected requests", () => {
  it("allows requests under the limit", async () => {
    const app = await buildLimitedApp({ max: 3, timeWindow: 60_000 });
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: "POST", url: "/protected" });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it("rejects a burst over the limit with 429 and retry metadata", async () => {
    const app = await buildLimitedApp({ max: 2, timeWindow: 60_000 });
    await app.inject({ method: "POST", url: "/protected" });
    await app.inject({ method: "POST", url: "/protected" });
    const res = await app.inject({ method: "POST", url: "/protected" });

    expect(res.statusCode).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["x-ratelimit-limit"]).toBe("2");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    await app.close();
  });

  it("tracks separate authenticated users independently", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      hook: "preHandler",
      keyGenerator: userOrIpKey("test.route"),
    });
    app.post("/protected", { preHandler: async (req) => {
      const userId = req.headers["x-user"] as string | undefined;
      if (userId) (req as any).user = { id: userId };
    } }, async () => ({ ok: true }));
    await app.ready();

    const userA1 = await app.inject({ method: "POST", url: "/protected", headers: { "x-user": "user_a" } });
    const userA2 = await app.inject({ method: "POST", url: "/protected", headers: { "x-user": "user_a" } });
    const userB1 = await app.inject({ method: "POST", url: "/protected", headers: { "x-user": "user_b" } });

    expect(userA1.statusCode).toBe(200);
    expect(userA2.statusCode).toBe(429); // user_a exhausted its own budget
    expect(userB1.statusCode).toBe(200); // user_b has an independent budget
    await app.close();
  });
});

describe("rate limiting — store failure behavior", () => {
  it("fails open (allows the request) when skipOnError is set and the store errors", async () => {
    class AlwaysFailingStore {
      incr(_key: string, cb: (err: Error) => void) {
        cb(new Error("database unavailable"));
      }
      child() {
        return new AlwaysFailingStore();
      }
    }

    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      store: AlwaysFailingStore as any,
      skipOnError: true,
    });
    app.post("/protected", async () => ({ ok: true }));
    await app.ready();

    // Even repeated requests all succeed because the (broken) store never
    // actually enforces a count — this is the documented degrade-to-open
    // behavior for RATE_LIMIT_STORE=database.
    const first = await app.inject({ method: "POST", url: "/protected" });
    const second = await app.inject({ method: "POST", url: "/protected" });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    await app.close();
  });

  it("would otherwise surface a 500 without skipOnError (documenting why we always set it for the DB store)", async () => {
    class AlwaysFailingStore {
      incr(_key: string, cb: (err: Error) => void) {
        cb(new Error("database unavailable"));
      }
      child() {
        return new AlwaysFailingStore();
      }
    }

    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 1,
      timeWindow: 60_000,
      store: AlwaysFailingStore as any,
      skipOnError: false,
    });
    app.post("/protected", async () => ({ ok: true }));
    await app.ready();

    const res = await app.inject({ method: "POST", url: "/protected" });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});

describe("PrismaRateLimitStore wired into a real rate-limited route", () => {
  it("enforces the limit using the store's real incr/child contract with an in-memory fake table", async () => {
    // A minimal in-memory stand-in for the rate_limit_buckets table so this
    // test doesn't require a real Postgres connection, while still
    // exercising PrismaRateLimitStore's actual incr/child logic end-to-end
    // through the real @fastify/rate-limit plugin.
    const { prisma } = await import("../src/db");
    const table = new Map<string, { count: number; resetAt: Date }>();
    const spy = vi
      .spyOn(prisma, "$queryRaw")
      .mockImplementation(async (..._args: any[]) => {
        const key = "shared-fake-key"; // single-route test; key extraction isn't needed
        const now = new Date();
        const existing = table.get(key);
        if (!existing || existing.resetAt <= now) {
          const resetAt = new Date(now.getTime() + 60_000);
          table.set(key, { count: 1, resetAt });
          return [{ count: 1, reset_at: resetAt }];
        }
        existing.count += 1;
        table.set(key, existing);
        return [{ count: existing.count, reset_at: existing.resetAt }];
      });

    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 2,
      timeWindow: 60_000,
      store: PrismaRateLimitStore as any,
      skipOnError: true,
    });
    app.post("/protected", async () => ({ ok: true }));
    await app.ready();

    const r1 = await app.inject({ method: "POST", url: "/protected" });
    const r2 = await app.inject({ method: "POST", url: "/protected" });
    const r3 = await app.inject({ method: "POST", url: "/protected" });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    expect(r3.statusCode).toBe(429);

    await app.close();
    spy.mockRestore();
  });
});
