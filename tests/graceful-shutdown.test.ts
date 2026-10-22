/**
 * Shutdown must release the Prisma connection pool on every teardown path.
 *
 * A deploy restarts both processes (API and worker); if the pool is not
 * closed explicitly, the next start inherits dangling Postgres connections
 * until the orchestrator's grace period expires. These tests pin the
 * worker's half of that contract:
 *
 *   - the client is disconnected exactly once per shutdown, after the
 *     in-flight cycle has drained and the leases have been released;
 *   - a job that outruns the drain budget still gets a disconnect (the
 *     leases stay claimed — that part is covered by
 *     tests/worker-shutdown-drain.test.ts);
 *   - a repeated signal does not disconnect a second time;
 *   - the successful disconnect is logged, so operators can see the pool
 *     was released rather than assumed.
 *
 * Prisma, the reconciliation loop, and the cleanup task are mocked, so the
 * suite runs offline like the rest of tests/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  /** Teardown events in the order the shutdown sequence performed them. */
  const order: string[] = [];
  const recordRelease = (args: { where?: Record<string, unknown> } | undefined) => {
    if (typeof args?.where?.claimedBy === "string") order.push("lease_release");
    return { count: 0 };
  };
  return {
    order,
    settlement: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => recordRelease(args)),
    },
    anchorSession: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async (args?: { where?: Record<string, unknown> }) => recordRelease(args)),
    },
    groupInvite: { updateMany: vi.fn(async () => ({ count: 0 })) },
    $disconnect: vi.fn(async () => {
      order.push("disconnect");
    }),
    /** Resolves the in-flight cycle; replaced per test. */
    gate: { wait: async (): Promise<void> => {} },
    logger: (() => {
      const logger: any = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };
      logger.child = vi.fn(() => logger);
      return logger;
    })(),
  };
});

// Every module that builds a logger at load time shares this instance, so
// shutdown lines can be asserted on.
vi.mock("pino", () => ({ default: vi.fn(() => h.logger) }));

vi.mock("../src/db", () => ({
  prisma: {
    settlement: h.settlement,
    anchorSession: h.anchorSession,
    groupInvite: h.groupInvite,
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function"
        ? arg({ settlement: h.settlement, anchorSession: h.anchorSession })
        : Promise.all(arg)
    ),
    $disconnect: h.$disconnect,
  },
}));

vi.mock("../src/worker/tasks/cleanup-challenges", () => ({
  cleanupChallenges: vi.fn(async () => {
    await h.gate.wait();
  }),
}));

vi.mock("../src/worker/reconciliation", () => ({
  startReconciliation: vi.fn(() => () => {}),
}));

const { startWorker } = await import("../src/worker/index");
const { config } = await import("../src/config");

describe("graceful shutdown disconnects Prisma", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    h.order.length = 0;
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    h.gate.wait = async () => {};
    h.settlement.findMany.mockResolvedValue([]);
    h.anchorSession.findMany.mockResolvedValue([]);
    h.settlement.updateMany.mockImplementation(async (args) => {
      if (typeof args?.where?.claimedBy === "string") h.order.push("lease_release");
      return { count: 0 };
    });
    h.anchorSession.updateMany.mockImplementation(async (args) => {
      if (typeof args?.where?.claimedBy === "string") h.order.push("lease_release");
      return { count: 0 };
    });
    h.$disconnect.mockClear();
    h.$disconnect.mockImplementation(async () => {
      h.order.push("disconnect");
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it("disconnects the client once the in-flight cycle has drained", async () => {
    const stop = await startWorker();
    await stop();

    expect(h.$disconnect).toHaveBeenCalledTimes(1);
    expect(h.order).toContain("disconnect");
  });

  it("releases its claims before disconnecting, and disconnects last", async () => {
    const stop = await startWorker();
    await stop();

    expect(h.order).toContain("lease_release");
    expect(h.order[h.order.length - 1]).toBe("disconnect");
  });

  it("logs the successful disconnection", async () => {
    const stop = await startWorker();
    await stop();

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "database_disconnected" }),
      "database disconnected"
    );
  });

  it("still disconnects when a job outruns the drain budget", async () => {
    // A cycle that never finishes: the hung-upstream case. Leases are left
    // to expire, but the pool must not be.
    h.gate.wait = () => new Promise<void>(() => {});

    vi.useFakeTimers();
    try {
      const stop = await startWorker();
      await vi.advanceTimersByTimeAsync(0);

      const shutdownPromise = stop();
      await vi.advanceTimersByTimeAsync(config.WORKER_SHUTDOWN_DRAIN_MS + 1);
      await shutdownPromise;

      expect(h.$disconnect).toHaveBeenCalledTimes(1);
      // The lease release is deliberately skipped — a claim stripped off a
      // running job is what lets the next worker submit it twice.
      expect(h.order).toEqual(["disconnect"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not disconnect twice on a repeated shutdown signal", async () => {
    const stop = await startWorker();
    await stop();
    expect(h.$disconnect).toHaveBeenCalledTimes(1);

    await stop();
    expect(h.$disconnect).toHaveBeenCalledTimes(1);
  });
});
