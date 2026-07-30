import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: { $queryRaw: vi.fn() },
}));

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { PrismaRateLimitStore } from "../src/services/rate-limit-store";

const prisma = h.prisma;

function incrAsync(store: PrismaRateLimitStore, key: string): Promise<{ current: number; ttl: number }> {
  return new Promise((resolve, reject) => {
    store.incr(key, (err, res) => (err ? reject(err) : resolve(res!)));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PrismaRateLimitStore", () => {
  it("reports the count and ttl returned by the atomic upsert", async () => {
    const store = new PrismaRateLimitStore({ timeWindow: 60_000 });
    const resetAt = new Date(Date.now() + 45_000);
    prisma.$queryRaw.mockResolvedValue([{ count: 3, reset_at: resetAt }]);

    const result = await incrAsync(store, "settlement.create:user:user_1");

    expect(result.current).toBe(3);
    expect(result.ttl).toBeGreaterThan(0);
    expect(result.ttl).toBeLessThanOrEqual(45_000);
  });

  it("bounds an excessively long key before querying", async () => {
    const store = new PrismaRateLimitStore({ timeWindow: 60_000 });
    prisma.$queryRaw.mockResolvedValue([{ count: 1, reset_at: new Date(Date.now() + 60_000) }]);

    await incrAsync(store, "x".repeat(10_000));

    const sql = prisma.$queryRaw.mock.calls[0][0];
    // Prisma.sql produces a tagged-template object; its `values` carry the
    // bound parameters, the first of which is our (bounded) key.
    const boundKey = sql.values[0];
    expect(typeof boundKey).toBe("string");
    expect(boundKey.length).toBeLessThanOrEqual(200);
  });

  it("propagates a store failure via the callback's error argument (fail-open is the caller's concern via skipOnError)", async () => {
    const store = new PrismaRateLimitStore({ timeWindow: 60_000 });
    prisma.$queryRaw.mockRejectedValue(new Error("connection refused"));

    await expect(incrAsync(store, "some-key")).rejects.toThrow("connection refused");
  });

  it("derives child stores that use the route's own time window", async () => {
    const parent = new PrismaRateLimitStore({ timeWindow: 60_000 });
    const child = parent.child({ timeWindow: 5_000 });
    prisma.$queryRaw.mockResolvedValue([{ count: 1, reset_at: new Date(Date.now() + 5_000) }]);

    const result = await incrAsync(child, "child-key");
    expect(result.ttl).toBeLessThanOrEqual(5_000);
  });
});
