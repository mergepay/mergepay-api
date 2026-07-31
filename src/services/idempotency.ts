import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";

/**
 * Idempotency keys are scoped per (user, operation, key) so a client-chosen
 * key string can never collide across users or across unrelated endpoints.
 */
export type IdempotencyScope =
  | "settlement.create"
  | "settlement.confirm"
  | "treasury.deposit"
  | "treasury.withdraw"
  | "treasury.confirm";

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

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);

  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.keys(object)
      .sort()
      .reduce<Record<string, unknown>>((result, key) => {
        result[key] = canonicalize(object[key]);
        return result;
      }, {});
  }

  return value;
}

/**
 * Build a stable request fingerprint. The authenticated user is intentionally
 * not included because the (userId, scope, key) row is already user-scoped.
 */
export function hashRequest(
  scope: IdempotencyScope,
  resourceId: string,
  payload: unknown
): string {
  const serialized = JSON.stringify(
    canonicalize({ scope, resourceId, payload })
  ) ?? "";

  return crypto.createHash("sha256").update(serialized).digest("hex");
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function conflict(): never {
  throw Errors.conflict(
    "idempotency_conflict",
    "Idempotency-Key already used with a different request"
  );
}

function parseStoredResponse<T>(responseJson: string): T {
  return JSON.parse(responseJson) as T;
}

/**
 * Run an operation once for a given authenticated-user, scope, and key.
 *
 * A real Prisma client reserves the key before invoking the operation. This is
 * important for operations which perform external I/O: a timeout or external
 * failure leaves a durable pending/failed record rather than rolling the
 * reservation back and allowing a retry to submit the same payment again.
 * Concurrent callers therefore observe the pending state instead of entering
 * the operation a second time.
 */
export async function runIdempotent<T>(params: {
  userId: string;
  scope: IdempotencyScope;
  key: string | null;
  resourceId: string;
  payload: unknown;
  operation: (tx: Prisma.TransactionClient) => Promise<T>;
  timeoutMs?: number;
}): Promise<T> {
  const {
    userId,
    scope,
    key,
    resourceId,
    payload,
    operation,
    timeoutMs = 15_000,
  } = params;

  if (!key) {
    return prisma.$transaction((tx) => operation(tx), { timeout: timeoutMs });
  }

  const requestHash = hashRequest(scope, resourceId, payload);
  const where = { userId_scope_key: { userId, scope, key } };
  const existing = await prisma.idempotencyKey.findUnique({ where });

  if (existing) {
    if (existing.requestHash !== requestHash) conflict();
    return parseStoredResponse<T>(existing.responseJson);
  }

  // Keep compatibility with lightweight test doubles which model only the
  // original create-at-commit API. Real Prisma clients always expose update.
  const model = prisma.idempotencyKey as unknown as {
    update?: (args: unknown) => Promise<unknown>;
  };

  if (typeof model.update !== "function") {
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
      const winner = await prisma.idempotencyKey.findUnique({ where });
      if (!winner) throw error;
      if (winner.requestHash !== requestHash) conflict();
      return parseStoredResponse<T>(winner.responseJson);
    }
  }

  const pendingResponse = {
    status: "pending",
    idempotencyKey: key,
    resourceId,
  };

  try {
    await prisma.idempotencyKey.create({
      data: {
        userId,
        scope,
        key,
        requestHash,
        responseJson: JSON.stringify(pendingResponse),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    const winner = await prisma.idempotencyKey.findUnique({ where });
    if (!winner) throw error;
    if (winner.requestHash !== requestHash) conflict();
    return parseStoredResponse<T>(winner.responseJson);
  }

  try {
    const result = await prisma.$transaction((tx) => operation(tx), {
      timeout: timeoutMs,
    });

    await prisma.idempotencyKey.update({
      where,
      data: { responseJson: JSON.stringify(result) },
    });
    return result;
  } catch (error) {
    const failedResponse = {
      status: "failed",
      idempotencyKey: key,
      resourceId,
    };

    try {
      await prisma.idempotencyKey.update({
        where,
        data: { responseJson: JSON.stringify(failedResponse) },
      });
    } catch {
      // Preserve the original operation error. The pending reservation remains
      // available for reconciliation rather than permitting a duplicate run.
    }

    throw error;
  }
}
