/**
 * Shared idempotency-key handling for state-changing settlement endpoints.
 *
 * Design: the key is "claimed" by inserting a row BEFORE the mutation runs,
 * relying on the unique constraint on `key` to serialize concurrent
 * requests — only one caller can win the insert race, so two simultaneous
 * retries can never both create a settlement or submit a payment. The
 * losing request(s) see the winner's row and either replay its stored
 * response, wait (in_progress), or get rejected (conflict: different user
 * or a different request body reusing the same key).
 *
 * Rows are retained for RETENTION_MS after creation so a client's retry
 * window has a bounded lifetime; cleanupExpiredIdempotencyKeys() is meant
 * to be swept periodically by a worker.
 */
import crypto from "node:crypto";
import { prisma } from "../db";

export const RETENTION_MS = 24 * 60 * 60 * 1000; // 24h

/** Hash the parts of a request that must match for a key to be replayed safely. */
export function hashIdempotentRequest(parts: {
  userId: string;
  scope: string;
  body: unknown;
}): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ userId: parts.userId, scope: parts.scope, body: parts.body }))
    .digest("hex");
}

export type IdempotencyOutcome =
  | { kind: "proceed" }
  | { kind: "in_progress" }
  | { kind: "conflict" }
  | { kind: "replay"; statusCode: number; body: unknown };

/**
 * Attempt to claim `key` for this (userId, requestHash) pair. Only one
 * concurrent caller gets `{ kind: "proceed" }` — the caller that wins must
 * follow up with completeIdempotencyKey() or failIdempotencyKey().
 */
export async function claimIdempotencyKey(params: {
  key: string;
  userId: string;
  requestHash: string;
}): Promise<IdempotencyOutcome> {
  const existing = await prisma.idempotencyKey.findUnique({ where: { key: params.key } });

  if (existing && existing.expiresAt < new Date()) {
    // Expired — treat the key as free. Delete defensively; if a concurrent
    // claimant already deleted it, the create below still resolves correctly.
    await prisma.idempotencyKey.delete({ where: { key: params.key } }).catch(() => {});
  } else if (existing) {
    return outcomeFor(existing, params);
  }

  try {
    await prisma.idempotencyKey.create({
      data: {
        key: params.key,
        userId: params.userId,
        requestHash: params.requestHash,
        status: "in_progress",
        expiresAt: new Date(Date.now() + RETENTION_MS),
      },
    });
    return { kind: "proceed" };
  } catch (e: any) {
    if (e?.code !== "P2002") throw e; // not a unique-constraint race — a real error
    const raced = await prisma.idempotencyKey.findUnique({ where: { key: params.key } });
    if (!raced) return { kind: "conflict" }; // deleted between our create and this read — caller can retry
    return outcomeFor(raced, params);
  }
}

function outcomeFor(
  row: { userId: string | null; requestHash: string; status: string; statusCode: number | null; responseJson: string | null },
  params: { userId: string; requestHash: string }
): IdempotencyOutcome {
  if (row.userId !== params.userId || row.requestHash !== params.requestHash) {
    return { kind: "conflict" };
  }
  if (row.status === "in_progress") {
    return { kind: "in_progress" };
  }
  return {
    kind: "replay",
    statusCode: row.statusCode ?? 200,
    body: row.responseJson ? JSON.parse(row.responseJson) : null,
  };
}

/** Record the winning claim's outcome so retries replay it instead of re-running the mutation. */
export async function completeIdempotencyKey(
  key: string,
  statusCode: number,
  body: unknown
): Promise<void> {
  await prisma.idempotencyKey
    .update({
      where: { key },
      data: { status: "completed", statusCode, responseJson: JSON.stringify(body) },
    })
    .catch(() => {});
}

/**
 * Release a claim that failed before producing a durable result, so a
 * legitimate retry with the same key can proceed instead of being wedged
 * "in_progress" forever.
 */
export async function failIdempotencyKey(key: string): Promise<void> {
  await prisma.idempotencyKey.delete({ where: { key } }).catch(() => {});
}

/** Sweep rows past their retention window. Returns the number removed. */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
