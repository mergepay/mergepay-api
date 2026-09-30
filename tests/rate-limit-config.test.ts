import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { config, envSchema } from "../src/config";
import { isGlobalRateLimitExempt } from "../src/lib/rate-limit";

describe("rate limit configuration", () => {
  it("gives SEP-10 challenge and verify distinct, independently configurable limits", () => {
    expect(config.RATE_LIMIT_AUTH_CHALLENGE_MAX).not.toBe(undefined);
    expect(config.RATE_LIMIT_AUTH_VERIFY_MAX).not.toBe(undefined);
    // Challenge requests are cheap and legitimately retried while a wallet
    // extension is still open; verify is the actual auth step and should be
    // tighter than challenge by default.
    expect(config.RATE_LIMIT_AUTH_CHALLENGE_MAX).toBe(20);
    expect(config.RATE_LIMIT_AUTH_VERIFY_MAX).toBe(10);
    expect(config.RATE_LIMIT_AUTH_VERIFY_MAX).toBeLessThan(
      config.RATE_LIMIT_AUTH_CHALLENGE_MAX
    );
  });

  it("gives settlement creation, confirmation, and execution their own explicit limits distinct from the global default", () => {
    expect(config.RATE_LIMIT_SETTLEMENT_CREATE_MAX).toBeLessThan(config.RATE_LIMIT_GLOBAL_MAX);
    expect(config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX).toBeLessThan(config.RATE_LIMIT_GLOBAL_MAX);
    expect(config.RATE_LIMIT_SETTLEMENT_EXECUTE_MAX).toBeLessThan(config.RATE_LIMIT_GLOBAL_MAX);
  });

  it("gives the anchor webhook its own explicit limit", () => {
    expect(config.RATE_LIMIT_ANCHOR_WEBHOOK_MAX).toBeGreaterThan(0);
    expect(config.RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS).toBeGreaterThan(0);
  });

  it("defaults to the in-memory store, requiring an explicit opt-in for the database-backed one", () => {
    expect(config.RATE_LIMIT_STORE).toBe("memory");
  });

  it("RATE_LIMIT_HEALTH config is defined", () => {
    expect(config.RATE_LIMIT_HEALTH).toBeGreaterThan(0);
  });
});

describe("rate limit window bounds", () => {
  // The schema caps every window at one hour. A window is the only thing
  // between a mistyped value and an endpoint that is effectively unlimited:
  // RATE_LIMIT_AUTH_VERIFY_WINDOW_MS=60000000 is a valid number and would hand
  // an attacker sixteen days of unlimited login attempts. Rejecting it at boot
  // turns a silent hole into a startup error.
  const HOUR_MS = 60 * 60 * 1000;

  it("accepts a window at the one-hour bound", () => {
    const parsed = envSchema.parse({
      ...process.env,
      RATE_LIMIT_AUTH_VERIFY_WINDOW_MS: String(HOUR_MS),
      RATE_LIMIT_SETTLEMENT_EXECUTE_WINDOW_MS: String(HOUR_MS),
    });
    expect(parsed.RATE_LIMIT_AUTH_VERIFY_WINDOW_MS).toBe(HOUR_MS);
    expect(parsed.RATE_LIMIT_SETTLEMENT_EXECUTE_WINDOW_MS).toBe(HOUR_MS);
  });

  it("rejects a window beyond the one-hour bound", () => {
    expect(
      envSchema.safeParse({
        ...process.env,
        RATE_LIMIT_AUTH_VERIFY_WINDOW_MS: String(HOUR_MS + 1),
      }).success
    ).toBe(false);

    expect(
      envSchema.safeParse({
        ...process.env,
        RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS: String(HOUR_MS + 1),
      }).success
    ).toBe(false);

    expect(
      envSchema.safeParse({
        ...process.env,
        RATE_LIMIT_SETTLEMENT_EXECUTE_WINDOW_MS: String(HOUR_MS + 1),
      }).success
    ).toBe(false);
  });

  it("rejects a non-positive or fractional window", () => {
    for (const value of ["0", "-1", "60000.5"]) {
      expect(
        envSchema.safeParse({
          ...process.env,
          RATE_LIMIT_GLOBAL_WINDOW_MS: value,
        }).success,
        `window ${value} should be rejected`
      ).toBe(false);
    }
  });

  it("rejects a non-positive maximum", () => {
    // `max: 0` would disable a route entirely rather than limit it, and a
    // negative value is meaningless; both must fail at boot.
    expect(
      envSchema.safeParse({ ...process.env, RATE_LIMIT_AUTH_VERIFY_MAX: "0" }).success
    ).toBe(false);
  });
});

describe("health and metadata rate limit exemptions", () => {
  it("keeps health and documentation endpoints available after global exhaustion", async () => {
    const app = Fastify({ logger: false });
    await app.register(rateLimit, {
      max: 2,
      timeWindow: 60_000,
      keyGenerator: (req) => `global:ip:${req.ip}`,
      allowList: isGlobalRateLimitExempt,
    });

    app.get("/health", async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }));
    app.get("/health/live", async () => ({ status: "ok" }));
    app.get("/docs/json", async () => ({ openapi: "3.0.0" }));
    app.get("/other", async () => ({ ok: true }));
    await app.ready();

    // Exhaust the global limit on a non-health route.
    await app.inject({ method: "GET", url: "/other" });
    await app.inject({ method: "GET", url: "/other" });
    const blocked = await app.inject({ method: "GET", url: "/other" });
    expect(blocked.statusCode).toBe(429);

    // Operational and metadata endpoints remain available after exhaustion.
    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe("ok");
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(200);

    await app.close();
  });
});
