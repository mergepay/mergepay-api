import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  prisma: { $executeRaw: vi.fn() },
}));

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  acquireWorkerLease,
  releaseWorkerLease,
} from "../../src/services/worker-lock";

const prisma = h.prisma;

function lastSql(): any {
  const calls = prisma.$executeRaw.mock.calls;
  return calls[calls.length - 1]?.[0];
}

function sqlText(sql: any): string {
  return (sql?.strings ?? []).join("?");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("acquireWorkerLease", () => {
  it("acquires a lease and binds key, owner, and ttl-based expiry", async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    const lease = await acquireWorkerLease("mergepay:worker-cycle", 30_000, "worker-a");

    expect(lease).toEqual({ key: "mergepay:worker-cycle", owner: "worker-a" });

    const sql = lastSql();
    expect(sqlText(sql)).toContain('INSERT INTO "worker_locks"');
    expect(sqlText(sql)).toContain('ON CONFLICT ("key") DO UPDATE');
    expect(sql.values[0]).toBe("mergepay:worker-cycle");
    expect(sql.values[1]).toBe("worker-a");

    const expiresAt = sql.values[2] as Date;
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now() + 29_000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it("returns null on lock contention from another worker", async () => {
    prisma.$executeRaw.mockResolvedValue(0);

    const lease = await acquireWorkerLease("mergepay:worker-cycle", 30_000, "worker-b");

    expect(lease).toBeNull();
  });

  it("reclaims an expired lease and only overwrites rows past their expiry", async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    const lease = await acquireWorkerLease("mergepay:worker-cycle", 30_000, "worker-c");

    expect(lease).toEqual({ key: "mergepay:worker-cycle", owner: "worker-c" });
    const sql = lastSql();
    expect(sqlText(sql)).toContain(
      'WHERE "worker_locks"."expires_at" <= CURRENT_TIMESTAMP'
    );
  });

  it("generates a fresh owner when none is supplied", async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    const first = await acquireWorkerLease("job:1", 10_000);
    const second = await acquireWorkerLease("job:1", 10_000);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.owner).toBeTruthy();
    expect(first!.owner).not.toBe(second!.owner);
  });
});

describe("releaseWorkerLease", () => {
  it("deletes only the lease owned by the releasing worker", async () => {
    prisma.$executeRaw.mockResolvedValue(1);

    await releaseWorkerLease({ key: "mergepay:worker-cycle", owner: "worker-a" });

    const sql = lastSql();
    expect(sqlText(sql)).toContain('DELETE FROM "worker_locks"');
    expect(sqlText(sql)).toContain('"key" =');
    expect(sqlText(sql)).toContain('"owner" =');
    expect(sql.values).toEqual(["mergepay:worker-cycle", "worker-a"]);
  });

  it("does not throw when no lease exists", async () => {
    prisma.$executeRaw.mockResolvedValue(0);

    await expect(
      releaseWorkerLease({ key: "mergepay:worker-cycle", owner: "stale-worker" })
    ).resolves.toBeUndefined();
  });
});
