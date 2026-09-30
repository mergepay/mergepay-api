/**
 * Issue #346 — `RATE_LIMIT_STORE` is a real switch.
 *
 * `RATE_LIMIT_STORE=database` is documented in the README, `.env.example`, and
 * `src/config.ts`, and `PrismaRateLimitStore` plus a `rate_limit_buckets`
 * migration both exist. It was nevertheless never passed to
 * `@fastify/rate-limit`: the class was imported into `src/app.ts` and left
 * unused, so every deployment — including one that set the variable — counted
 * requests in per-process memory. A multi-instance deployment behind a load
 * balancer then enforced N times the configured limit, and the fix looked
 * applied in configuration and code review alike.
 *
 * These tests pin both halves: the options the plugin derives from the setting,
 * and the observable consequence — a request either does or does not hit the
 * counter table.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({})),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    refreshToken: model(),
    $queryRaw: vi.fn(async () => [
      { count: 1, reset_at: new Date(Date.now() + 60_000) },
    ]),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { rateLimitStoreOptions } from "../src/plugins/rate-limit";
import { PrismaRateLimitStore } from "../src/services/rate-limit-store";

describe("rateLimitStoreOptions", () => {
  it("selects the Postgres store and fail-open for RATE_LIMIT_STORE=database", () => {
    const options = rateLimitStoreOptions("database");
    expect(options.store).toBe(PrismaRateLimitStore);
    // Without this, a transient database error becomes a 500 on every route.
    expect(options.skipOnError).toBe(true);
  });

  it("leaves the plugin's default in-memory store alone for the default setting", () => {
    // An explicit `store: undefined` would still be handed to the plugin, and
    // an explicit `skipOnError` would change memory-store behaviour.
    expect(rateLimitStoreOptions("memory")).toEqual({});
  });

  it("treats an unrecognised value as the default rather than silently using Postgres", () => {
    expect(rateLimitStoreOptions("redis")).toEqual({});
  });
});

describe("RATE_LIMIT_STORE=database on a booted app", () => {
  beforeEach(() => {
    vi.resetModules();
    h.prisma.$queryRaw.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("counts every request in the rate_limit_buckets table", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "database");
    const { buildApp } = await import("../src/app");
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);

    // /health is allow-listed, so use a route that actually counts. The
    // statement is the store's atomic upsert against the shared table.
    const counted = await app.inject({ method: "GET", url: "/me" });
    expect(counted.statusCode).not.toBe(200);

    expect(h.prisma.$queryRaw).toHaveBeenCalled();
    // Prisma.sql returns a query object, not a string; `.sql` is the statement.
    const statement = (h.prisma.$queryRaw.mock.calls.at(-1)?.[0] ?? {}) as { sql?: string };
    expect(statement.sql).toContain("rate_limit_buckets");
  });

  it("adds no per-request query with the default in-memory store", async () => {
    const { buildApp } = await import("../src/app");
    const app = await buildApp();

    await app.inject({ method: "GET", url: "/me" });

    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("fails open — a broken counter table must not 500 the route", async () => {
    vi.stubEnv("RATE_LIMIT_STORE", "database");
    h.prisma.$queryRaw.mockRejectedValueOnce(
      new Error("relation \"rate_limit_buckets\" does not exist")
    );

    const { buildApp } = await import("../src/app");
    const app = await buildApp();

    const res = await app.inject({ method: "GET", url: "/me" });
    // 401 is what an unauthenticated GET /me returns; the point is that it is
    // not 500, i.e. the limiter degraded to "allow" instead of taking the route
    // down with it.
    expect(res.statusCode).toBe(401);
  });
});
