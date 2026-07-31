/**
 * Idempotency for state-changing settlement requests.
 *
 * Mobile networks and wallet callbacks retry aggressively after a timeout, and
 * a settlement write is not something a client may perform twice: a duplicate
 * `POST /expenses/:id/settle` mints a second settlement record, and a duplicate
 * `POST /settlements/:id/confirm` could hand the same signed envelope to the
 * worker twice. Both are prevented here rather than in each route.
 *
 * ## The contract
 *
 * A key is a durable row identified by `(userId, scope, key)`:
 *
 *  - **userId** — the *authenticated* caller. A key one user chose is invisible
 *    to every other user, so nothing about it is reusable across accounts.
 *  - **scope** — the operation ("settlement.create", "settlement.confirm", …),
 *    so the same client-chosen string can't be replayed across unrelated
 *    endpoints.
 *  - **key** — the client's `Idempotency-Key` header, validated with Zod
 *    (1–255 characters of `A–Z a–z 0–9 - _ . :`).
 *
 * The row also stores a `requestHash` over the request's intent (scope,
 * resource id, and body), which is what binds a key to a *payload*: replaying
 * the same key with different content is a conflict, never a silent success.
 *
 * ## Lifecycle
 *
 * The reservation row is written **before** the operation runs, so the unique
 * constraint — not application logic — is what serializes concurrent retries:
 *
 *   in_progress → completed   the stored response is replayed forever after
 *   in_progress → failed      the operation threw; the key may be retried
 *
 * A second request arriving while the first is still `in_progress` gets a 409
 * rather than a second execution, so two racing retries produce exactly one
 * durable outcome. An `in_progress` reservation older than
 * `IN_PROGRESS_TIMEOUT_MS` is assumed to belong to a crashed process and may be
 * taken over — safe because the operation itself runs inside a database
 * transaction, so a process that died mid-operation left nothing behind.
 *
 * ## Retry behaviour on failure
 *
 * `operation` runs inside `prisma.$transaction`, and callers only perform
 * durable settlement writes inside it (Horizon submission is the worker's job,
 * never the request's). A failure therefore rolls back completely, and marking
 * the key `failed` lets the client retry the same key without risking a
 * duplicate record or a second chain submission.
 */
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

/** Documented bounds for the `Idempotency-Key` header. */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/** How long a completed key replays before it is swept. */
export const IDEMPOTENCY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How long an `in_progress` reservation blocks a retry before it is treated as
 * abandoned. Long enough to outlast any request this API serves (the operation
 * transaction times out at 15s), short enough that a crashed process does not
 * wedge a client's key for the full retention window.
 */
export const IN_PROGRESS_TIMEOUT_MS = 60_000;

export type IdempotencyState = "in_progress" | "completed" | "failed";

export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(
    IDEMPOTENCY_KEY_PATTERN,
    "Idempotency-Key must be alphanumeric with -_.: separators"
  );

/** Extract and validate the Idempotency-Key header, if present. */
export function readIdempotencyKey(headers: Record<string, unknown>): string | null {
  const raw = headers["idempotency-key"];
  if (raw === undefined || raw === null) return null;

  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.badRequest(
      "invalid_idempotency_key",
      `Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters of letters, numbers, '-', '_', '.', or ':'`
    );
  }

  return parsed.data;
}

/**
 * Same as `readIdempotencyKey`, but for endpoints where the key is mandatory —
 * submission, where a retry that slipped through could mean a second payment.
 */
export function requireIdempotencyKey(
  headers: Record<string, unknown>,
  operation: string
): string {
  const key = readIdempotencyKey(headers);
  if (!key) {
    throw Errors.badRequest(
      "missing_idempotency_key",
      `Idempotency-Key header is required for ${operation}`
    );
  }
  return key;
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

function inProgress(): never {
  throw Errors.conflict(
    "idempotency_in_progress",
    "A request with this Idempotency-Key is still being processed. Retry shortly."
  );
}

function parseStoredResponse<T>(responseJson: string | null): T {
  return JSON.parse(responseJson ?? "null") as T;
}

/** Reservation row as this module reads it, tolerating older/partial shapes. */
interface KeyRow {
  requestHash: string;
  responseJson: string | null;
  status?: string | null;
  updatedAt?: Date | null;
  createdAt?: Date | null;
}

/**
 * Interpret a stored row's lifecycle state.
 *
 * Rows written before the lifecycle column existed carry no status; a stored
 * response is treated as `completed` and anything else as `failed`, which is
 * the conservative reading — it never replays a response that was never
 * produced, and never blocks a legitimate retry.
 */
function stateOf(row: KeyRow): IdempotencyState {
  const status = row.status ?? null;
  if (status === "in_progress" || status === "completed" || status === "failed") {
    return status;
  }
  return row.responseJson != null ? "completed" : "failed";
}

function isAbandoned(row: KeyRow, now: number): boolean {
  const started = (row.updatedAt ?? row.createdAt ?? null)?.getTime();
  if (started === undefined) return false;
  return now - started > IN_PROGRESS_TIMEOUT_MS;
}

type ClientWithWrites = {
  update?: (args: unknown) => Promise<unknown>;
  updateMany?: (args: unknown) => Promise<{ count: number }>;
};

/**
 * Whether the configured Prisma client supports the reserve-then-finalize
 * flow. Lightweight test doubles model only `findUnique`/`create`, and for
 * those the legacy create-at-commit path below is used instead.
 */
function supportsLifecycle(model: ClientWithWrites): boolean {
  return typeof model.update === "function" && typeof model.updateMany === "function";
}

/**
 * Run an operation once for a given authenticated-user, scope, and key.
 *
 * Returns the operation's result, or the stored result of the first request
 * that used this key. Throws:
 *
 *  - 409 `IDEMPOTENCY_CONFLICT` — the key was used with a different payload
 *  - 409 `IDEMPOTENCY_IN_PROGRESS` — a request with this key is still running
 *
 * With no key (`key: null`) this is a plain transactional call: idempotency is
 * opt-in for creation, and mandatory only where the route says so.
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
  const model = prisma.idempotencyKey as unknown as ClientWithWrites;

  const existing = (await prisma.idempotencyKey.findUnique({ where })) as KeyRow | null;

  if (existing) {
    // Bound to the payload as well as the caller: the same key with different
    // content is a client bug, and answering it with the first request's result
    // would hide a real divergence.
    if (existing.requestHash !== requestHash) conflict();

    const state = stateOf(existing);
    if (state === "completed") return parseStoredResponse<T>(existing.responseJson);
    if (state === "in_progress" && !isAbandoned(existing, Date.now())) inProgress();

    // `failed`, or an abandoned reservation from a crashed process: retry it,
    // but only if this request wins the re-claim.
    if (supportsLifecycle(model)) {
      const reclaimed = await reclaim({ userId, scope, key, requestHash });
      if (!reclaimed) {
        const winner = (await prisma.idempotencyKey.findUnique({ where })) as KeyRow | null;
        if (!winner) inProgress();
        if (winner.requestHash !== requestHash) conflict();
        if (stateOf(winner) === "completed") {
          return parseStoredResponse<T>(winner.responseJson);
        }
        inProgress();
      }
      return finalize({ where, requestHash, resourceId, operation, timeoutMs });
    }
  }

  if (!supportsLifecycle(model)) {
    return runCreateAtCommit({
      userId,
      scope,
      key,
      requestHash,
      where,
      operation,
      timeoutMs,
    });
  }

  // Reserve the key before doing any work. The unique constraint is what makes
  // two simultaneous retries resolve to one execution: the loser lands here
  // with P2002 and reads the winner's row instead of running the operation.
  try {
    await prisma.idempotencyKey.create({
      data: {
        userId,
        scope,
        key,
        requestHash,
        status: "in_progress",
        responseJson: null,
        expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
      } as never,
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;

    const winner = (await prisma.idempotencyKey.findUnique({ where })) as KeyRow | null;
    if (!winner) throw error;
    if (winner.requestHash !== requestHash) conflict();
    if (stateOf(winner) === "completed") {
      return parseStoredResponse<T>(winner.responseJson);
    }
    inProgress();
  }

  return finalize({ where, requestHash, resourceId, operation, timeoutMs });
}

/**
 * Atomically move a `failed` or abandoned reservation back to `in_progress`.
 * Returns false when another request got there first.
 */
async function reclaim(params: {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
}): Promise<boolean> {
  const staleBefore = new Date(Date.now() - IN_PROGRESS_TIMEOUT_MS);
  const { count } = await prisma.idempotencyKey.updateMany({
    where: {
      userId: params.userId,
      scope: params.scope,
      key: params.key,
      requestHash: params.requestHash,
      OR: [
        { status: "failed" },
        { status: "in_progress", updatedAt: { lt: staleBefore } },
      ],
    } as never,
    data: {
      status: "in_progress",
      responseJson: null,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
    } as never,
  });
  return count === 1;
}

/** Run the reserved operation and record its outcome against the key. */
async function finalize<T>(params: {
  where: { userId_scope_key: { userId: string; scope: string; key: string } };
  requestHash: string;
  resourceId: string;
  operation: (tx: Prisma.TransactionClient) => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  const { where, operation, timeoutMs } = params;

  try {
    const result = await prisma.$transaction((tx) => operation(tx), {
      timeout: timeoutMs,
    });

    await prisma.idempotencyKey.update({
      where,
      data: {
        status: "completed",
        statusCode: 200,
        responseJson: JSON.stringify(result),
      } as never,
    });
    return result;
  } catch (error) {
    // The operation ran inside a transaction, so nothing durable survives a
    // failure. Marking the key `failed` — rather than leaving it wedged
    // `in_progress` — is what gives the client a defined retry: the same key
    // may be sent again, and it will run exactly once more.
    try {
      await prisma.idempotencyKey.update({
        where,
        data: { status: "failed", statusCode: null, responseJson: null } as never,
      });
    } catch {
      // Preserve the original operation error. The reservation stays
      // in_progress and becomes reclaimable after IN_PROGRESS_TIMEOUT_MS.
    }

    throw error;
  }
}

/**
 * Legacy path for Prisma clients that expose only `findUnique`/`create`
 * (lightweight test doubles). The key row is written inside the same
 * transaction as the operation, so a failure rolls the reservation back and a
 * concurrent duplicate loses on the unique constraint at commit time.
 */
async function runCreateAtCommit<T>(params: {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  where: { userId_scope_key: { userId: string; scope: string; key: string } };
  operation: (tx: Prisma.TransactionClient) => Promise<T>;
  timeoutMs: number;
}): Promise<T> {
  const { userId, scope, key, requestHash, where, operation, timeoutMs } = params;

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
            status: "completed",
            statusCode: 200,
            responseJson: JSON.stringify(result),
            expiresAt: new Date(Date.now() + IDEMPOTENCY_RETENTION_MS),
          } as never,
        });
        return result;
      },
      { timeout: timeoutMs }
    );
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;
    const winner = (await prisma.idempotencyKey.findUnique({ where })) as KeyRow | null;
    if (!winner) throw error;
    if (winner.requestHash !== requestHash) conflict();
    if (stateOf(winner) !== "completed") inProgress();
    return parseStoredResponse<T>(winner.responseJson);
  }
}

/** Sweep keys past their retention window. Returns the number removed. */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: { expiresAt: { lt: new Date() } } as never,
  });
  return result.count;
}
