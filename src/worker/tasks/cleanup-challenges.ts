import { prisma } from "../../db";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../../lib/time-bounds";

/**
 * Remove SEP-10 challenge replay records that can no longer affect security:
 *
 *  1. **Window closed.** A row whose `expiresAt` has passed is a record of an
 *     envelope that can no longer be redeemed — verification rejects it on
 *     time bounds before replay state is even consulted — so it is deleted.
 *     Rows are created with `expiresAt = maxTime + skew + 1s`, so this also
 *     sweeps consumed challenges once their envelopes' windows close.
 *  2. **Retention elapsed.** Rows are kept for `CHALLENGE_RETENTION_MS` after
 *     their window closes (forensics on replay attempts against a
 *     recently-live window), then removed regardless of which timestamp
 *     aged out.
 *
 * The cutoffs are deliberately staggered (issue #709): a single retention
 * cutoff alone would leave expired-window rows lying around for a day, and
 * deleting by expiry alone would erase evidence of a replay attempt the
 * moment its window closed.
 */
export const CHALLENGE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Grace past `expiresAt` before the window-closed sweep claims a row. Rows
 * already bake the skew tolerance into their expiry; this extra buffer means
 * a sweep racing a verification on another instance (small clock jitter
 * between processes) can never delete a record while its envelope is being
 * redeemed.
 */
export const CHALLENGE_EXPIRY_GRACE_SECONDS = CLOCK_SKEW_TOLERANCE_SECONDS;

export async function cleanupChallenges(now = new Date()): Promise<number> {
  // The retention sweep keeps recently expired rows for forensics; the grace
  // keeps rows whose envelope could still be inside its skew-extended window.
  const expiryCutoff = new Date(
    now.getTime() - CHALLENGE_EXPIRY_GRACE_SECONDS * 1000
  );
  const retentionCutoff = new Date(now.getTime() - CHALLENGE_RETENTION_MS);

  const result = await prisma.sep10Challenge.deleteMany({
    where: {
      OR: [
        { expiresAt: { lt: expiryCutoff } },
        { consumedAt: { lt: retentionCutoff } },
        { expiresAt: { lt: retentionCutoff } },
      ],
    },
  });
  return result.count;
}
