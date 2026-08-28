import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ deleteMany: vi.fn() }));

vi.mock("../src/db", () => ({
  prisma: { sep10Challenge: { deleteMany: h.deleteMany } },
}));

import {
  CHALLENGE_RETENTION_MS,
  cleanupChallenges,
} from "../src/worker/tasks/cleanup-challenges";

describe("cleanupChallenges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.deleteMany.mockResolvedValue({ count: 3 });
  });

  it("deletes records older than the retention window by consumed or expiry time", async () => {
    const now = new Date("2026-08-27T12:00:00.000Z");

    await expect(cleanupChallenges(now)).resolves.toBe(3);
    expect(h.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { consumedAt: { lt: new Date(now.getTime() - CHALLENGE_RETENTION_MS) } },
          { expiresAt: { lt: new Date(now.getTime() - CHALLENGE_RETENTION_MS) } },
        ],
      },
    });
  });
});
