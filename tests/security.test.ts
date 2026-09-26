import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../src/app";
import { FastifyInstance } from "fastify";

describe("Security headers middleware (Fastify Helmet)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets standard security response headers on API endpoints", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
    });

    expect(res.statusCode).toBe(200);

    // X-Content-Type-Options
    expect(res.headers["x-content-type-options"]).toBe("nosniff");

    // X-Frame-Options
    expect(res.headers["x-frame-options"]).toBe("DENY");

    // Strict-Transport-Security (HSTS)
    expect(res.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");

    // Cross-Origin policies
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");

    // Referrer Policy
    expect(res.headers["referrer-policy"]).toBe("no-referrer");

    // X-DNS-Prefetch-Control & X-Download-Options
    expect(res.headers["x-dns-prefetch-control"]).toBe("off");
    expect(res.headers["x-download-options"]).toBe("noopen");

    // Content Security Policy
    expect(res.headers["content-security-policy"]).toBeDefined();
    const csp = res.headers["content-security-policy"] as string;
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it("preserves Swagger UI documentation route accessibility", async () => {
    const docsHtmlRes = await app.inject({
      method: "GET",
      url: "/docs",
    });
    expect(docsHtmlRes.statusCode).toBe(200);
    expect(docsHtmlRes.headers["content-type"]).toContain("text/html");

    const docsJsonRes = await app.inject({
      method: "GET",
      url: "/docs/json",
    });
    expect(docsJsonRes.statusCode).toBe(200);
    expect(docsJsonRes.headers["content-type"]).toContain("application/json");

    expect(docsHtmlRes.headers["x-content-type-options"]).toBe("nosniff");
    expect(docsHtmlRes.headers["x-frame-options"]).toBe("DENY");
  });
});
