import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";

/**
 * Idempotency keys are scoped per (user, operation, key) so a client-chosen
 * key string can never collide across users or across unrelated endpoints.
 */
export type IdempotencyScope = "settlement.create" | "settlement.confirm";

export const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.:-]+$/, "Idempotency-Key must be alphanumeric with -_.: separators");

/** Extract and validate the Idempotency-Key header, if present. */
export function readIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers["idempotency-key"];
  if (raw === undefined || raw === null) return null;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.badRequest(
      "invalid_idempotency_key",
      "Idempotency-Key must be 1-255 characters of letters, numbers, '-', '_', '.', or ':'"
    );
  }
  return parsed.data;
}

/** Exposed for tests; deliberately excludes userId since the (userId, scope, key) row is already user-scoped. */
export function hashRequest(scope: IdempotencyScope, resourceId: string, payload: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ scope, resourceId, payload }))
    .digest("hex");
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/**
 * Run `operation` at most once for a given (user, scope, key) combination.
 *
 * - No key supplied: runs the operation directly (idempotency is opt-in).
 * - Key seen before with the same request payload: returns the cached
 *   response without re-running the operation.
 * - Key seen before with a *different* request payload: throws a 409
 *   conflict without running the operation.
 * - Concurrent requests with the same new key: exactly one caller runs
 *   `operation`; the others receive its result once it commits. This is
 *   enforced by writing the idempotency record inside the same database
 *   transaction as the operation itself, so a duplicate key insert can only
 *   fail after the winning transaction has fully committed.
 */
export async function runIdempotent<T>(params: {
  userId: string;
  scope: IdempotencyScope;
  key: string | null;
  resourceId: string;
  payload: unknown;
  operation: (tx: Prisma.TransactionClient) => Promise<T>;
  /**
   * Max transaction lifetime in ms. Operations that call out to Stellar/
   * Horizon while holding the transaction (to keep the DB write atomic with
   * the idempotency record) need more headroom than Prisma's 5s default.
   */
  timeoutMs?: number;
}): Promise<T> {
  const { userId, scope, key, resourceId, payload, operation, timeoutMs = 15_000 } = params;

  if (!key) {
    return prisma.$transaction((tx) => operation(tx), { timeout: timeoutMs });
  }

  const requestHash = hashRequest(scope, resourceId, payload);

  const existing = await prisma.idempotencyKey.findUnique({
    where: { userId_scope_key: { userId, scope, key } },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw Errors.conflict(
        "idempotency_conflict",
        "Idempotency-Key already used with a different request"
      );
    }
    return JSON.parse(existing.responseJson) as T;
  }

  try {
    return await prisma.$transaction(
      async (tx) => {
        const result = await operation(tx);
        await tx.idempotencyKey.create({
          data: {
            userId,
            scope,
            key,
            requestHash,
            responseJson: JSON.stringify(result),
          },
        });
        return result;
      },
      { timeout: timeoutMs }
    );
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;

    // Another concurrent request with the same key won the race and already
    // committed. Its transaction included both the operation and the
    // idempotency record, so it is guaranteed to be present now.
    const winner = await prisma.idempotencyKey.findUnique({
      where: { userId_scope_key: { userId, scope, key } },
    });
    if (!winner) throw error;
    if (winner.requestHash !== requestHash) {
      throw Errors.conflict(
        "idempotency_conflict",
        "Idempotency-Key already used with a different request"
      );
    }
    return JSON.parse(winner.responseJson) as T;
  }
}
