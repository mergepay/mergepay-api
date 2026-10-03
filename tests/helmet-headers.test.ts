/**
 * Security headers (issue #393).
 *
 * @fastify/helmet is registered in src/app.ts with a hardened configuration
 * for a JSON REST API. These tests pin the headers that matter — the ones the
 * issue names (X-Content-Type-Options, X-Frame-Options,
 * Strict-Transport-Security) and the neighbouring protections configured
 * alongside them — so a refactor of the helmet options cannot silently drop
 * them. Health endpoints are used as the probe surface because they exercise
 * the real app wiring (plugins included) without needing authentication or
 * database state.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    $queryRawUnsafe: h.queryRawUnsafe,
  },
}));

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.queryRaw.mockResolvedValue([{ 1: 1 }]);
  h.queryRawUnsafe.mockResolvedValue([{ 1: 1 }]);
  if (!app) app = await buildApp();
});

describe("helmet security headers", () => {
  it("sets X-Content-Type-Options: nosniff on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sets X-Frame-Options: DENY (frameguard action deny)", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["x-frame-options"]).toBe("DENY");
  });

  it("sets Strict-Transport-Security with a one-year max age, subdomains, and preload", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    const hsts = res.headers["strict-transport-security"];
    expect(hsts).toBe("max-age=31536000; includeSubDomains; preload");
  });

  it("locks down the content security policy to default-src 'none'", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("does not leak referrers (Referrer-Policy: no-referrer)", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("sets cross-origin isolation headers (COOP same-origin, CORP cross-origin)", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
  });

  it("applies the same headers to error responses, not just successes", async () => {
    // A validation failure flows through the error handler, which must not
    // bypass the helmet hooks.
    const res = await app.inject({ method: "POST", url: "/auth/challenge", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
  });
});
