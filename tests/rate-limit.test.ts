import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

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
