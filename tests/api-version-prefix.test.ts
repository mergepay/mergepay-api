/**
 * API version prefix (issue #386).
 *
 * Every domain route is registered under `/api/v1` in src/app.ts, so a client —
 * mergepay-web included — can depend on a stable, versioned base path without
 * each route file spelling it out. This suite proves three things a rename of
 * this size can silently break:
 *
 *  1. the route table actually carries the prefix (and only the prefix),
 *  2. operational endpoints — health, docs, the static uploads server — stay at
 *     the root, and
 *  3. legacy unversioned paths still resolve during the migration window via
 *     `rewriteUrl`, while unknown paths are untouched.
 *
 * The body-limit table in src/app.ts is keyed by route-relative paths, so the
 * same change also has to normalise the prefix in its `onRoute` hook; the
 * assertions below pin that down through the captured route options.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    invite: model(),
    invitation: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    refreshToken: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp, API_V1_PREFIX, toVersionedUrl } from "../src/app";
import { config } from "../src/config";

interface CapturedRoute {
  method?: string | string[];
  url?: string;
  bodyLimit?: number;
}

const captured: CapturedRoute[] = [];

/** `METHOD url` strings, the shape the rate-limit audit also reads. */
function routeKeys(): string[] {
  return captured.map((route) => {
    const method = Array.isArray(route.method)
      ? route.method.join(",")
      : String(route.method ?? "");
    return `${method} ${route.url ?? ""}`;
  });
}

beforeAll(async () => {
  await buildApp({
    onRoute: (routeOptions) => {
      captured.push(routeOptions as CapturedRoute);
    },
    rateLimit: "off",
  });
});

describe("toVersionedUrl", () => {
  it("moves a legacy root path under the version prefix, query string included", () => {
    expect(toVersionedUrl("/auth/challenge")).toBe(`${API_V1_PREFIX}/auth/challenge`);
    expect(toVersionedUrl("/groups/group_1/expenses?limit=2&cursor=abc")).toBe(
      `${API_V1_PREFIX}/groups/group_1/expenses?limit=2&cursor=abc`
    );
    expect(toVersionedUrl("/uploads/receipt")).toBe(`${API_V1_PREFIX}/uploads/receipt`);
  });

  it("moves the older unversioned /api/... paths, without doubling the prefix", () => {
    expect(toVersionedUrl("/api/sep24/deposit")).toBe(`${API_V1_PREFIX}/sep24/deposit`);
    expect(toVersionedUrl("/api/webhooks")).toBe(`${API_V1_PREFIX}/webhooks`);
    expect(toVersionedUrl("/api/exchange-rates?pair=XLM/USDC")).toBe(
      `${API_V1_PREFIX}/exchange-rates?pair=XLM/USDC`
    );
  });

  it("leaves already-versioned, operational, and unknown paths alone", () => {
    for (const url of [
      `${API_V1_PREFIX}/auth/challenge`,
      "/health",
      "/health/deep?probe=1",
      "/docs/json",
      "/uploads/1f0c9a4e-receipt.png",
      "/test/slow",
      "/",
    ]) {
      expect(toVersionedUrl(url)).toBe(url);
    }
  });
});

describe("registered route table", () => {
  it("registers representative domain routes under /api/v1 only", () => {
    const keys = routeKeys();
    for (const expected of [
      "POST /api/v1/auth/challenge",
      "POST /api/v1/auth/verify",
      "GET /api/v1/me",
      "POST /api/v1/groups",
      "POST /api/v1/groups/:id/expenses",
      "POST /api/v1/settlements/:id/confirm",
      "GET /api/v1/history",
      "POST /api/v1/uploads/receipt",
      "POST /api/v1/sep24/deposit",
      "GET /api/v1/exchange-rates",
    ]) {
      expect(keys, `missing ${expected}`).toContain(expected);
    }

    // The same paths must not also be registered unversioned: the legacy
    // spellings are served by the rewrite, not by duplicate route entries.
    for (const unexpected of [
      "POST /auth/challenge",
      "GET /me",
      "POST /api/sep24/deposit",
      "POST /uploads/receipt",
    ]) {
      expect(keys, `unexpected legacy registration ${unexpected}`).not.toContain(unexpected);
    }
  });

  it("keeps health, docs, and the static upload server at the root", () => {
    const keys = routeKeys();
    for (const rootRoute of [
      "GET /health",
      "GET /health/live",
      "GET /health/deep",
      "GET /docs/json",
      "HEAD,GET /uploads/*",
    ]) {
      expect(keys, `missing root route ${rootRoute}`).toContain(rootRoute);
    }
  });

  it("prefixes every route that is neither operational nor a test-only OPTIONS catch-all", () => {
    const unprefixed = routeKeys().filter(
      (key) =>
        !key.includes(`${API_V1_PREFIX}/`) &&
        key !== "OPTIONS *" &&
        !key.endsWith(" /health") &&
        !key.includes(" /health/") &&
        !key.includes(" /docs") &&
        !key.includes(" /uploads/")
    );

    expect(unprefixed).toEqual([]);
  });

  it("still applies the body limits keyed by route-relative path", () => {
    // If the onRoute normalisation in src/app.ts were missing, both of these
    // would silently lose their dedicated bodyLimit and fall back to the
    // global JSON limit.
    for (const url of ["/api/v1/auth/challenge", "/api/v1/uploads/receipt"]) {
      const route = captured.find((entry) => entry.url === url);
      expect(route, `no captured route for ${url}`).toBeDefined();
    }
    const challenge = captured.find((entry) => entry.url === "/api/v1/auth/challenge")!;
    expect(challenge.bodyLimit).toBe(config.AUTH_BODY_LIMIT_BYTES);
    const receipt = captured.find((entry) => entry.url === "/api/v1/uploads/receipt")!;
    expect(receipt.bodyLimit).toBe(config.MULTIPART_FILE_SIZE_BYTES + 64 * 1024);
  });
});

describe("request routing", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({ rateLimit: "off" });
  });

  it("serves a validation rejection from the canonical versioned path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("still serves the same route at its legacy path", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("resolves a previously hardcoded /api/... route under the version prefix", async () => {
    const canonical = await app.inject({
      method: "GET",
      url: "/api/v1/sep24/transaction",
    });
    const legacy = await app.inject({
      method: "GET",
      url: "/api/sep24/transaction",
    });

    // Both reach the route; without a session the auth guard answers 401.
    expect(canonical.statusCode).toBe(401);
    expect(legacy.statusCode).toBe(401);
  });

  it("keeps the operational root endpoints reachable", async () => {
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);

    const docs = await app.inject({ method: "GET", url: "/docs/json" });
    expect(docs.statusCode).toBe(200);
  });

  it("answers 404 for unknown paths, versioned or not", async () => {
    const versioned = await app.inject({ method: "GET", url: "/api/v1/not-a-route" });
    expect(versioned.statusCode).toBe(404);
    expect(versioned.json().error.code).toBe("NOT_FOUND");

    const legacy = await app.inject({ method: "GET", url: "/not-a-route" });
    expect(legacy.statusCode).toBe(404);
    expect(legacy.json().error.code).toBe("NOT_FOUND");
  });
});
