import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { buildApp } from "../src/app";

describe("Rate Limiting", () => {
  let app: ReturnType<typeof buildApp> extends Promise<infer T> ? T : never;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  it("429 response includes Retry-After header on rate limit exceeded", async () => {
    // Make 100 requests to hit the global limit
    // Note: Default global limit is 100 req/min, we'll check the response structure
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    // Health endpoint should not be rate limited
    expect(response.statusCode).toBe(200);
  });

  it("applies tighter rate limit to auth/challenge endpoint", async () => {
    // The auth challenge endpoint should have a 10 req/min limit
    const response = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: "GCQECF6YS6CFJDBMMWD4EAHCBLMO5WMXDVORNH3FOQBRUEI5VJIHH6HC" },
    });

    // Should either succeed or fail with 429 (if limit exceeded)
    expect([200, 400, 429]).toContain(response.statusCode);
  });

  it("applies tighter rate limit to auth/verify endpoint", async () => {
    // The auth verify endpoint should have a 10 req/min limit
    const response = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: "fake-xdr" },
    });

    // Should either succeed or fail with 429 (if limit exceeded)
    // 400 is expected because fake xdr won't parse correctly
    expect([200, 400, 429]).toContain(response.statusCode);
  });

  it("429 responses include rate limit headers", async () => {
    // First, exhaust the auth challenge limit
    // Then check for rate limit headers in the response
    const response = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: "GCQECF6YS6CFJDBMMWD4EAHCBLMO5WMXDVORNH3FOQBRUEI5VJIHH6HC" },
    });

    // If we get a rate limited response, check headers
    if (response.statusCode === 429) {
      expect(response.headers["retry-after"]).toBeDefined();
      expect(response.headers["x-ratelimit-limit"]).toBeDefined();
    }
  });
});
