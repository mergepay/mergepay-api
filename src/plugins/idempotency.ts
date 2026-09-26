/**
 * HTTP-level idempotency for settlement execution.
 *
 * `src/services/idempotency.ts` makes an *operation* run once: the caller
 * wraps a database transaction and gets its return value replayed. That is the
 * right shape for routes whose whole effect is one transaction, and the
 * settlement create and confirm routes use it directly.
 *
 * Execution is different. `POST /api/settlements/execute` builds a payment and
 * hands it toward Horizon, and what a retrying client needs back is not the
 * operation's return value but *the response the first attempt sent* — same
 * status code, same body. A client that retried after a 202 and received a 200
 * would draw a different conclusion about what happened. This plugin therefore
 * caches at the reply layer:
 *
 *   1. `preHandler` reads `X-Idempotency-Key`, hashes the request body, and
 *      reserves the key. A completed reservation short-circuits the route and
 *      replays the stored status and payload verbatim.
 *   2. `onSend` captures the outgoing response against the reservation, so the
 *      cached value is the response actually sent rather than a reconstruction.
 *
 * ## Concurrency
 *
 * The reservation row is written before the handler runs, and `(userId, scope,
 * key)` is unique. Two simultaneous retries therefore resolve at the database:
 * the winner proceeds, the loser sees an `in_progress` reservation and gets
 * 409 rather than a second execution. This is what stops a duplicate payment
 * build or a double submission to Horizon, and it does not depend on both
 * requests reaching the same process.
 *
 * ## Payload binding
 *
 * The reservation stores a hash of the request body alongside the key. Reusing
 * a key with different content is a 409, never a silent replay of the first
 * request's result — answering a different request with a stale response would
 * hide a real client bug behind an apparent success.
 *
 * ## Expiry
 *
 * Reservations expire after `IDEMPOTENCY_TTL_MS` (24 hours by default) and are
 * swept by the existing cleanup job. Past that window a key is free to be
 * reused, which is the documented contract rather than an accident: an
 * unbounded key space is a table that only grows.
 */
import crypto from "node:crypto";
import fp from "fastify-plugin";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { config } from "../config";
import { prisma } from "../db";
import { Errors } from "../errors";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  IDEMPOTENCY_KEY_PATTERN,
} from "../services/idempotency";

/**
 * The header this plugin reads. Distinct from the bare `Idempotency-Key` the
 * service-level helper reads on the create/confirm routes: those two mechanisms
 * are not interchangeable, and a client that sent one expecting the other's
 * semantics would be surprised in exactly the way that costs money.
 */
export const IDEMPOTENCY_HEADER = "x-idempotency-key";

export const idempotencyKeySchema = z
  .string()
  .min(IDEMPOTENCY_KEY_MIN_LENGTH)
  .max(IDEMPOTENCY_KEY_MAX_LENGTH)
  .regex(
    IDEMPOTENCY_KEY_PATTERN,
    "X-Idempotency-Key must be alphanumeric with -_.: separators"
  );

/** State carried from `preHandler` to `onSend` for one request. */
interface IdempotencyContext {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  /** False when the reply is a replay, so `onSend` must not re-record it. */
  recording: boolean;
}

declare module "fastify" {
  interface FastifyRequest {
    idempotency?: IdempotencyContext;
  }
}

interface StoredReservation {
  requestHash: string;
  status: string;
  statusCode: number | null;
  responseJson: string | null;
  updatedAt?: Date | null;
  createdAt?: Date | null;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

/** Deterministic hash of the request body, order-insensitive for objects. */
export function hashRequestBody(scope: string, body: unknown): string {
  const serialized = JSON.stringify(canonicalize({ scope, body })) ?? "";
  return crypto.createHash("sha256").update(serialized).digest("hex");
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

/** Read and validate the header. Returns null when absent. */
export function readExecutionKey(headers: Record<string, unknown>): string | null {
  const raw = headers[IDEMPOTENCY_HEADER];
  if (raw === undefined || raw === null) return null;

  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = idempotencyKeySchema.safeParse(value);
  if (!parsed.success) {
    throw Errors.badRequest(
      "invalid_idempotency_key",
      `X-Idempotency-Key must be ${IDEMPOTENCY_KEY_MIN_LENGTH}-${IDEMPOTENCY_KEY_MAX_LENGTH} characters of letters, numbers, '-', '_', '.', or ':'`
    );
  }
  return parsed.data;
}

function conflict(): never {
  throw Errors.conflict(
    "idempotency_conflict",
    "X-Idempotency-Key already used with a different request"
  );
}

function inProgress(): never {
  throw Errors.conflict(
    "idempotency_in_progress",
    "A request with this X-Idempotency-Key is still being processed. Retry shortly."
  );
}

/**
 * Whether an `in_progress` reservation is old enough to have been abandoned by
 * a crashed process. Until then a concurrent retry gets 409 rather than a
 * second execution.
 */
function isAbandoned(row: StoredReservation, now: number): boolean {
  const started = (row.updatedAt ?? row.createdAt ?? null)?.getTime();
  if (started === undefined) return false;
  return now - started > config.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS;
}

/** Replay a stored response, preserving the original status code and body. */
function replay(reply: FastifyReply, row: StoredReservation): FastifyReply {
  // `Idempotent-Replay` lets a client tell a cached response from a fresh one
  // without having to diff the body against what it expected.
  reply.header("idempotent-replay", "true");
  return reply
    .code(row.statusCode ?? 200)
    .send(JSON.parse(row.responseJson ?? "null"));
}

/**
 * Reserve a key for this request, or resolve it against an existing
 * reservation. Returns the reservation context when the handler should run,
 * or null when the reply has already been sent as a replay.
 */
async function reserve(params: {
  userId: string;
  scope: string;
  key: string;
  requestHash: string;
  reply: FastifyReply;
}): Promise<IdempotencyContext | null> {
  const { userId, scope, key, requestHash, reply } = params;
  const where = { userId_scope_key: { userId, scope, key } };

  const existing = (await prisma.idempotencyKey.findUnique({
    where,
  })) as StoredReservation | null;

  if (existing) {
    if (existing.requestHash !== requestHash) conflict();

    if (existing.status === "completed") {
      replay(reply, existing);
      return null;
    }

    if (existing.status === "in_progress" && !isAbandoned(existing, Date.now())) {
      inProgress();
    }

    // `failed`, or a reservation abandoned by a crashed process. Re-claim it,
    // but only if this request wins the race to do so.
    const { count } = await prisma.idempotencyKey.updateMany({
      where: {
        userId,
        scope,
        key,
        requestHash,
        OR: [
          { status: "failed" },
          {
            status: "in_progress",
            updatedAt: {
              lt: new Date(Date.now() - config.IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS),
            },
          },
        ],
      } as never,
      data: {
        status: "in_progress",
        statusCode: null,
        responseJson: null,
        expiresAt: new Date(Date.now() + config.IDEMPOTENCY_TTL_MS),
      } as never,
    });

    if (count !== 1) {
      // Someone else re-claimed it first. Re-read: they may already have
      // finished, in which case their response is the correct answer here.
      const winner = (await prisma.idempotencyKey.findUnique({
        where,
      })) as StoredReservation | null;
      if (!winner) inProgress();
      if (winner.requestHash !== requestHash) conflict();
      if (winner.status === "completed") {
        replay(reply, winner);
        return null;
      }
      inProgress();
    }

    return { userId, scope, key, requestHash, recording: true };
  }

  try {
    await prisma.idempotencyKey.create({
      data: {
        userId,
        scope,
        key,
        requestHash,
        status: "in_progress",
        statusCode: null,
        responseJson: null,
        expiresAt: new Date(Date.now() + config.IDEMPOTENCY_TTL_MS),
      } as never,
    });
  } catch (error) {
    if (!isUniqueConstraintViolation(error)) throw error;

    // Lost the insert race. The unique constraint — not application logic — is
    // what guarantees only one of the two requests executes.
    const winner = (await prisma.idempotencyKey.findUnique({
      where,
    })) as StoredReservation | null;
    if (!winner) throw error;
    if (winner.requestHash !== requestHash) conflict();
    if (winner.status === "completed") {
      replay(reply, winner);
      return null;
    }
    inProgress();
  }

  return { userId, scope, key, requestHash, recording: true };
}

/** Record the response actually sent against its reservation. */
async function record(
  context: IdempotencyContext,
  statusCode: number,
  payload: unknown
): Promise<void> {
  const where = {
    userId_scope_key: {
      userId: context.userId,
      scope: context.scope,
      key: context.key,
    },
  };

  // Only a success is durable. A 4xx/5xx leaves the key `failed` so the client
  // may retry it: the alternative — caching the error — would wedge a key on a
  // transient fault and force the client to invent a new one, which is exactly
  // the uncontrolled retry this plugin exists to prevent.
  const succeeded = statusCode >= 200 && statusCode < 300;

  await prisma.idempotencyKey.update({
    where,
    data: succeeded
      ? {
          status: "completed",
          statusCode,
          responseJson: typeof payload === "string" ? payload : JSON.stringify(payload),
          expiresAt: new Date(Date.now() + config.IDEMPOTENCY_TTL_MS),
        }
      : { status: "failed", statusCode: null, responseJson: null },
  } as never);
}

export interface IdempotentRouteOptions {
  /** Operation label stored on the reservation. */
  scope: string;
  /** Whether a request without the header is rejected. */
  required?: boolean;
}

/**
 * Fastify plugin exposing `app.idempotent(options)`, a preHandler that makes
 * one route idempotent at the HTTP layer.
 *
 * Applied per route rather than globally: idempotency is only meaningful for
 * requests that are unsafe to repeat, and reserving a key for every GET would
 * add a write to the read path.
 */
async function idempotencyPlugin(app: FastifyInstance) {
  app.decorate(
    "idempotent",
    function idempotent(options: IdempotentRouteOptions) {
      const { scope, required = false } = options;

      return async function idempotencyPreHandler(
        req: FastifyRequest,
        reply: FastifyReply
      ) {
        const key = readExecutionKey(req.headers as Record<string, unknown>);

        if (!key) {
          if (required) {
            throw Errors.badRequest(
              "missing_idempotency_key",
              `X-Idempotency-Key header is required for ${scope}`
            );
          }
          return;
        }

        // The key is scoped to the authenticated user, so one client's chosen
        // string is invisible to every other client and cannot be guessed into
        // replaying someone else's response.
        const userId = req.user?.id;
        if (!userId) {
          throw Errors.unauthorized("Authentication required");
        }

        const requestHash = hashRequestBody(scope, req.body ?? null);
        const context = await reserve({
          userId,
          scope,
          key,
          requestHash,
          reply,
        });

        // Null means the reply was already sent as a replay; returning it
        // stops Fastify from invoking the route handler.
        if (!context) return reply;

        req.idempotency = context;
      };
    }
  );

  // Capture the response as it is sent, rather than reconstructing it from the
  // handler's return value: what a retry must receive is what the first
  // attempt actually put on the wire.
  app.addHook("onSend", async (req, reply, payload) => {
    const context = req.idempotency;
    if (!context || !context.recording) return payload;

    context.recording = false;

    try {
      await record(context, reply.statusCode, payload);
    } catch (error) {
      // A failed bookkeeping write must not turn a completed settlement into
      // an error response. The reservation stays `in_progress` and becomes
      // reclaimable once it ages past the abandonment window.
      req.log.error(
        { err: error, scope: context.scope },
        "failed to record idempotent response"
      );
    }

    return payload;
  });
}

declare module "fastify" {
  interface FastifyInstance {
    idempotent(
      options: IdempotentRouteOptions
    ): (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}

export default fp(idempotencyPlugin, { name: "idempotency" });
