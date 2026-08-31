/**
 * Shutdown must not strip a lease off a job that is still running.
 *
 * The worker releases its claims on SIGTERM so a redeploy does not leave jobs
 * parked until their leases lapse. That is only safe once nothing of ours is
 * still submitting: clearing `claimedBy` while a payment is in flight lets the
 * next worker claim the same settlement and submit it a second time. These
 * tests pin the ordering — drain first, release second — and the bounded
 * fallback when a job outruns the drain budget.
 *
 * The cycle is held open through `reconcileSettlements`, a real dependency of
 * `runWorkerCycle`, so the drain is exercised through the worker's own code
 * path rather than a re-implementation of it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settlement: {
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  anchorSession: {
    findMany: vi.fn(async () => []),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  groupInvite: { updateMany: vi.fn(async () => ({ count: 0 })) },
  /** Resolves the in-flight cycle; replaced per test. */
  gate: { wait: async (): Promise<void> => {} },
}));

vi.mock("../src/db", () => ({
  prisma: {
    settlement: h.settlement,
    anchorSession: h.anchorSession,
    groupInvite: h.groupInvite,
    $executeRaw: vi.fn(async () => 1),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg({ settlement: h.settlement, anchorSession: h.anchorSession }) : Promise.all(arg)
    ),
    $disconnect: vi.fn(async () => {}),
  },
}));

vi.mock("../src/services/settlement-reconciliation", () => ({
  reconcileSettlements: vi.fn(async () => {
    await h.gate.wait();
  }),
}));

vi.mock("../src/worker/reconciliation", () => ({
  startReconciliation: () => () => {},
  reconcileAnchors: vi.fn(async () => {}),
}));

vi.mock("../src/worker/tasks/cleanup-challenges", () => ({
  cleanupChallenges: vi.fn(async () => {}),
}));

const { startWorker } = await import("../src/worker/index");
const { config } = await import("../src/config");

/**
 * The shutdown release, isolated from the recovery sweep.
 *
 * Both clear the same columns, so they are told apart by their `where`: the
 * shutdown release targets this process's own claims (`claimedBy`), while
 * recovery targets any lapsed lease (`leaseExpiresAt`).
 */
function ownLeaseReleases(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.filter(([arg]) => {
    const where = (arg as { where?: Record<string, unknown> } | undefined)?.where;
    return typeof where?.claimedBy === "string";
  });
}

describe("worker shutdown drain", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.gate.wait = async () => {};
    h.settlement.findMany.mockResolvedValue([]);
    h.anchorSession.findMany.mockResolvedValue([]);
    h.settlement.updateMany.mockResolvedValue({ count: 0 });
    h.anchorSession.updateMany.mockResolvedValue({ count: 0 });
  });

  it("waits for the in-flight cycle before releasing any lease", async () => {
    let releaseCycle!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      releaseCycle = resolve;
    });

    let cycleFinished = false;
    h.gate.wait = async () => {
      await inFlight;
      cycleFinished = true;
    };

    // Order is the whole assertion: a lease release that observes an
    // unfinished cycle is the duplicate-submission bug.
    const observed: boolean[] = [];
    const record = async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (typeof where?.claimedBy === "string") observed.push(cycleFinished);
      return { count: 0 };
    };
    h.settlement.updateMany.mockImplementation(record as never);
    h.anchorSession.updateMany.mockImplementation(record as never);

    const stop = await startWorker();
    const shutdownPromise = stop();

    // Shutdown is blocked on the drain; the release writes must not have run.
    await Promise.resolve();
    await Promise.resolve();
    const releasedDuringDrain = ownLeaseReleases(h.settlement.updateMany).length;

    releaseCycle();
    await shutdownPromise;

    expect(releasedDuringDrain).toBe(0);
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((finished) => finished)).toBe(true);
  });

  it("leaves leases to expire when a job outruns the drain budget", async () => {
    // A cycle that never finishes: the hung-upstream case.
    h.gate.wait = () => new Promise<void>(() => {});

    vi.useFakeTimers();
    try {
      const stop = await startWorker();
      // Let the cycle reach the hung reconcile before shutting down.
      await vi.advanceTimersByTimeAsync(0);

      const shutdownPromise = stop();
      await vi.advanceTimersByTimeAsync(config.WORKER_SHUTDOWN_DRAIN_MS + 1);
      await shutdownPromise;

      // This worker's own leases must be untouched — a lease left to expire is
      // recoverable, a payment submitted twice is not. Recovery of *other*
      // workers' expired leases (keyed on leaseExpiresAt) is unrelated and
      // allowed, so match only the shutdown release, which is keyed on
      // claimedBy: WORKER_ID.
      expect(ownLeaseReleases(h.settlement.updateMany)).toHaveLength(0);
      expect(ownLeaseReleases(h.anchorSession.updateMany)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is idempotent: a second shutdown does not release again", async () => {
    const stop = await startWorker();

    await stop();
    const callsAfterFirst = ownLeaseReleases(h.settlement.updateMany).length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await stop();
    expect(ownLeaseReleases(h.settlement.updateMany).length).toBe(callsAfterFirst);
  });
});
