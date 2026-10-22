import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  buildCorsOptions,
  isOriginAllowed,
  originPolicy,
  type CorsEnvironment,
} from "../src/lib/cors";

/**
 * CORS for the API (see src/lib/cors.ts).
 *
 * Two layers are covered:
 *
 * 1. The option builder, driven by synthetic environments, so every branch of
 *    the origin policy (`WEB_URL` allow-list, `"*"`, Vercel previews, empty
 *    configuration) can be exercised without booting the server or mutating
 *    the process environment.
 * 2. The real `buildApp()` over `app.inject()`, with `WEB_URL` and
 *    `CORS_ALLOW_CREDENTIALS` set before the app module is loaded, because
 *    `src/config.ts` parses `process.env` once at import time. Vitest gives
 *    every test file its own module registry, so those variables cannot leak
 *    into the rest of the suite — and `afterAll` restores them anyway.
 */

const APP_ORIGIN = "https://app.mergepay.example";
const STAGING_ENTRY = "https://staging.mergepay.example/";
const STAGING_ORIGIN = "https://staging.mergepay.example";
const DENIED_ORIGIN = "https://evil.example";

function env(overrides: Partial<CorsEnvironment> = {}): CorsEnvironment {
  return {
    WEB_URL: "",
    CORS_ALLOW_CREDENTIALS: false,
    CORS_ALLOW_METHODS: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    CORS_ALLOW_HEADERS: "Content-Type,Authorization,X-Requested-With,Idempotency-Key",
    CORS_EXPOSE_HEADERS: "X-Request-ID,X-Correlation-ID",
    CORS_MAX_AGE: 86400,
    ...overrides,
  };
}

describe("buildCorsOptions — environment-driven policy", () => {
  it("denies every cross-origin origin when WEB_URL is empty", () => {
    const policy = originPolicy("");
    expect(policy.allowAll).toBe(false);
    expect(policy.origins).toEqual([]);
    expect(isOriginAllowed(DENIED_ORIGIN, policy)).toBe(false);
    expect(isOriginAllowed(APP_ORIGIN, policy)).toBe(false);
    // No Origin header means the request is not cross-origin at all: it falls
    // through to the route's own authentication instead of a CORS verdict.
    expect(isOriginAllowed(undefined, policy)).toBe(true);
  });

  it("allows every origin when WEB_URL is *", () => {
    const policy = originPolicy("*");
    expect(policy.allowAll).toBe(true);
    expect(isOriginAllowed(DENIED_ORIGIN, policy)).toBe(true);
    expect(isOriginAllowed(APP_ORIGIN, policy)).toBe(true);
  });

  it("matches the allow-list across whitespace and trailing slashes", () => {
    const policy = originPolicy(` ${APP_ORIGIN} , ${STAGING_ENTRY}`);
    expect(policy.origins).toEqual([APP_ORIGIN, STAGING_ORIGIN]);
    expect(isOriginAllowed(APP_ORIGIN, policy)).toBe(true);
    expect(isOriginAllowed(`${APP_ORIGIN}/`, policy)).toBe(true);
    expect(isOriginAllowed(STAGING_ORIGIN, policy)).toBe(true);
    expect(isOriginAllowed(`${STAGING_ORIGIN}/nested`, policy)).toBe(false);
    expect(isOriginAllowed(DENIED_ORIGIN, policy)).toBe(false);
  });

  it("extends to Vercel previews only when WEB_URL names a vercel.app host", () => {
    const previewAllowed = originPolicy("https://mergepay-web.vercel.app");
    expect(previewAllowed.allowVercelPreviews).toBe(true);
    expect(isOriginAllowed("https://mergepay-web-git-branch.vercel.app", previewAllowed)).toBe(true);
    expect(isOriginAllowed(DENIED_ORIGIN, previewAllowed)).toBe(false);

    const previewsOff = originPolicy(APP_ORIGIN);
    expect(previewsOff.allowVercelPreviews).toBe(false);
    expect(isOriginAllowed("https://anything.vercel.app", previewsOff)).toBe(false);
  });

  it("passes credentials through only when the environment asks for them", () => {
    expect(buildCorsOptions(env()).credentials).toBe(false);
    expect(buildCorsOptions(env({ CORS_ALLOW_CREDENTIALS: true })).credentials).toBe(true);
  });

  it("restricts methods and headers to the configured lists", () => {
    const options = buildCorsOptions(env({ CORS_ALLOW_METHODS: "get, post" }));
    // Uppercased, and only what was configured — never echoed from the request.
    expect(options.methods).toEqual(["GET", "POST"]);
    expect(options.allowedHeaders).toEqual([
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Idempotency-Key",
    ]);
  });

  it("falls back to the plugin default when a list variable is empty", () => {
    const options = buildCorsOptions(env({ CORS_ALLOW_METHODS: "", CORS_ALLOW_HEADERS: " , " }));
    // Left unset rather than advertised as an empty header.
    expect(options.methods).toBeUndefined();
    expect(options.allowedHeaders).toBeUndefined();
  });

  it("spells out the preflight behaviour instead of relying on defaults", () => {
    const options = buildCorsOptions(env());
    expect(options.hook).toBe("onRequest");
    expect(options.preflight).toBe(true);
    expect(options.preflightContinue).toBe(false);
    expect(options.optionsSuccessStatus).toBe(204);
    expect(options.strictPreflight).toBe(true);
    expect(options.maxAge).toBe(86400);
  });
});

// The environment the integration tests below run against. Must be set before
// ../src/app is imported: src/config.ts parses process.env once, at module load.
const ORIGINAL_ENV = {
  WEB_URL: process.env.WEB_URL,
  CORS_ALLOW_CREDENTIALS: process.env.CORS_ALLOW_CREDENTIALS,
};
process.env.WEB_URL = `${APP_ORIGIN},${STAGING_ENTRY}`;
process.env.CORS_ALLOW_CREDENTIALS = "true";

describe("CORS preflight and responses over HTTP", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const { buildApp } = await import("../src/app");
    app = await buildApp();
  }, 15000);

  afterAll(async () => {
    await app?.close();
    // Restore so nothing here is visible to a later file in the same worker.
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const preflight = (origin?: string, method = "POST") =>
    app.inject({
      method: "OPTIONS",
      url: "/health/live",
      headers: origin
        ? { origin, "access-control-request-method": method, "access-control-request-headers": "authorization,content-type" }
        : {},
    });

  it("answers a preflight from an allowed origin with 204 and the CORS headers", async () => {
    const res = await preflight(APP_ORIGIN);

    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(res.headers["access-control-allow-methods"]).toBe(
      "GET, HEAD, PUT, PATCH, POST, DELETE, OPTIONS"
    );
    const allowedHeaders = String(res.headers["access-control-allow-headers"]);
    expect(allowedHeaders).toContain("Authorization");
    expect(allowedHeaders).toContain("Content-Type");
    expect(res.headers["access-control-max-age"]).toBe("86400");
    // Cached responses must be keyed per origin, so the preflight varies on it.
    expect(String(res.headers.vary)).toContain("Origin");
  });

  it("accepts an origin whose allow-list entry carried a trailing slash", async () => {
    const res = await preflight(STAGING_ORIGIN);
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(STAGING_ORIGIN);
  });

  it("withholds every CORS header from a preflight by an origin outside WEB_URL", async () => {
    const res = await preflight(DENIED_ORIGIN);

    // @fastify/cors only answers preflights it allowed; a denied one falls
    // through to the not-found handler. Either way the browser sees no
    // Access-Control-Allow-* headers, which is what blocks the request.
    expect(res.statusCode).toBe(404);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
    // Still varied on Origin so an intermediary cannot serve one origin's
    // verdict to another.
    expect(String(res.headers.vary)).toContain("Origin");
  });

  it("rejects a malformed preflight (no Origin, no request method) with 400", async () => {
    const res = await preflight();
    expect(res.statusCode).toBe(400);
  });

  it("exposes an allowed origin on an actual request", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live", headers: { origin: APP_ORIGIN } });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(APP_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
    expect(String(res.headers.vary)).toContain("Origin");
  });

  it("omits CORS headers on an actual request from a disallowed origin", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live", headers: { origin: DENIED_ORIGIN } });

    // The route still serves — enforcement is the browser refusing to hand
    // the response to the page — but nothing is exposed cross-origin.
    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("omits CORS headers for same-origin and non-browser clients", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
