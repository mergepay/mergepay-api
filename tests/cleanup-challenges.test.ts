import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("../src/db", () => ({
  prisma: { sep10Challenge: { deleteMany: h.deleteMany } },
}));

import {
  CHALLENGE_EXPIRY_GRACE_SECONDS,
  CHALLENGE_RETENTION_MS,
  cleanupChallenges,
} from "../src/worker/tasks/cleanup-challenges";

describe("cleanupChallenges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.deleteMany.mockResolvedValue({ count: 3 });
  });

  it("purges rows whose validity window has closed and rows past retention", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");

    await expect(cleanupChallenges(now)).resolves.toBe(3);
    expect(h.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          // Expired-window sweep: any envelope that can no longer be redeemed
          // (with the skew grace before its row is claimed).
          { expiresAt: { lt: new Date(now.getTime() - 30_000) } },
          // Retention sweeps: rows past the 24h window by either timestamp.
          { consumedAt: { lt: new Date(now.getTime() - CHALLENGE_RETENTION_MS) } },
          { expiresAt: { lt: new Date(now.getTime() - CHALLENGE_RETENTION_MS) } },
        ],
      },
    });
  });

  it("does not claim rows still inside the clock-skew expiry grace", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    h.deleteMany.mockResolvedValue({ count: 0 });

    await cleanupChallenges(now);

    const call = h.deleteMany.mock.calls[0][0] as {
      where: { OR: Array<{ expiresAt?: { lt: Date } }> };
    };
    const expiryCutoff = call.where.OR.find((c) => c.expiresAt)?.expiresAt?.lt;
    expect(expiryCutoff).toEqual(
      new Date(now.getTime() - CHALLENGE_EXPIRY_GRACE_SECONDS * 1000)
    );
    // A row whose envelope expired 20s ago (expiresAt ≈ now - 20s + skew)
    // sits after this cutoff, so the sweep cannot delete it mid-redemption.
    expect(expiryCutoff!.getTime()).toBeLessThan(now.getTime() - 20_000);
  });
});
