import { prisma } from "../db";

export type IdempotencyClaim =
  // No prior attempt for this (user, key) pair — go ahead and process the
  // request, then call completeIdempotencyKey/failIdempotencyKey with `id`.
  | { outcome: "claimed"; id: string }
  // A prior attempt with the same key and the same request fingerprint
  // already finished successfully — replay its stored response verbatim
  // instead of processing again.
  | { outcome: "completed"; responseJson: string }
  // A prior attempt with the same key and the same request fingerprint is
  // still running (or crashed without reaching a terminal state). The
  // caller must not proceed — concurrently processing the same key would
  // risk a duplicate settlement update / Horizon submission.
  | { outcome: "in_progress" }
  // The key has been used before for a different request (different
  // amount, asset, participants, memo, or signed transaction).
  | { outcome: "conflict" };

function isUniqueConstraintViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/**
 * Atomically claim an idempotency key for a given user, or report the
 * outcome of a prior attempt under the same key.
 *
 * The claim is a plain unique-constrained INSERT: if two requests race on
 * the same (userId, key), only one INSERT can succeed, so only the winner
 * proceeds to do the actual work. The loser looks up what happened instead
 * of guessing from a re-read — this keeps "one submission, one authoritative
 * state transition" true even under concurrent retries, without holding a
 * database transaction open around the caller's own work (which, for
 * settlement confirmation, includes no Horizon I/O — that happens later in
 * the worker).
 */
export async function claimIdempotencyKey(
  userId: string,
  key: string,
  requestHash: string
): Promise<IdempotencyClaim> {
  try {
    const record = await prisma.idempotencyKey.create({
      data: { userId, key, requestHash, status: "in_progress" },
    });
    return { outcome: "claimed", id: record.id };
  } catch (e) {
    if (!isUniqueConstraintViolation(e)) throw e;

    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    // Extremely unlikely (deleted between the failed insert and this read),
    // but fail closed rather than silently reprocessing.
    if (!existing) throw e;

    if (existing.requestHash !== requestHash) {
      return { outcome: "conflict" };
    }
    if (existing.status === "succeeded" && existing.responseJson) {
      return { outcome: "completed", responseJson: existing.responseJson };
    }
    if (existing.status === "in_progress") {
      return { outcome: "in_progress" };
    }

    // A previous attempt with this exact key + intent failed (or a process
    // crashed before reaching a terminal state) — safe to retry.
    await prisma.idempotencyKey.update({
      where: { id: existing.id },
      data: { status: "in_progress", responseJson: null },
    });
    return { outcome: "claimed", id: existing.id };
  }
}

export async function completeIdempotencyKey(id: string, response: unknown): Promise<void> {
  await prisma.idempotencyKey.update({
    where: { id },
    data: { status: "succeeded", responseJson: JSON.stringify(response) },
  });
}

export async function failIdempotencyKey(id: string): Promise<void> {
  await prisma.idempotencyKey.update({
    where: { id },
    data: { status: "failed" },
  });
}
