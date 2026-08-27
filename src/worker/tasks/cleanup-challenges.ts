import { prisma } from "../../db";

/**
 * Remove consumed or expired SEP-10 challenge replay records once they are
 * older than the retention window. The cutoff keeps recent rows available for
 * replay detection while preventing unbounded growth.
 */
export const CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

export async function cleanupChallenges(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - CHALLENGE_RETENTION_MS);
  const result = await prisma.sep10Challenge.deleteMany({
    where: {
      OR: [
        { consumedAt: { lt: cutoff } },
        { expiresAt: { lt: cutoff } },
      ],
    },
  });
  return result.count;
}
