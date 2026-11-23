/**
 * Comprehensive audit logging middleware for state-changing API requests (#896).
 *
 * Records mutating requests (POST, PUT, PATCH, DELETE) with actor user ID,
 * route pattern, timestamp, response status, and deeply scrubbed payload metadata.
 */
import type { FastifyReply, FastifyRequest, onResponseHookHandler } from "fastify";
import { prisma } from "../db";
import {
  emitAuditEvent,
  sanitizeAuditMetadata,
} from "../lib/audit-logger";
import { isRecord, serializeAuditMetadata } from "../schemas/json-metadata";

export const MUTATING_HTTP_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export interface StateMutationAuditOptions {
  actionPrefix?: string;
  recordBody?: boolean;
}

/**
 * Fastify onResponse hook recording state-changing API operations.
 */
export function stateMutationAudit(
  options: StateMutationAuditOptions = {}
): onResponseHookHandler {
  const { actionPrefix = "api.mutation", recordBody = true } = options;

  return function stateMutationAuditHook(
    this: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
    done: () => void
  ): void {
    done();

    try {
      if (!MUTATING_HTTP_METHODS.has(req.method)) return;

      const userId = (req.user as { id?: string } | undefined)?.id ?? null;
      const routeUrl = req.routeOptions.url ?? req.url.split("?")[0];
      const action = `${actionPrefix}.${req.method.toLowerCase()}`;
      const outcome = reply.statusCode >= 200 && reply.statusCode < 400 ? "success" : "failure";

      const sanitizedBody =
        recordBody && req.body && typeof req.body === "object"
          ? sanitizeAuditMetadata(req.body)
          : undefined;
      const scrubbedBody = isRecord(sanitizedBody) ? sanitizedBody : undefined;

      const metadata: Record<string, unknown> = {
        method: req.method,
        route: routeUrl,
        statusCode: reply.statusCode,
        timestamp: new Date().toISOString(),
        ...(scrubbedBody ? { payload: scrubbedBody } : {}),
      };

      // Asynchronous non-blocking database write
      void prisma.auditLog
        .create({
          data: {
            userId,
            action,
            entityType: "api_route",
            entityId: routeUrl,
            metadata: serializeAuditMetadata(metadata),
          },
        })
        .catch(() => {
          // Best effort persistence
        });

      // Streaming structured JSON mirror
      emitAuditEvent({
        action,
        userId,
        actorType: userId ? "user" : "system",
        entityType: "api_route",
        entityId: routeUrl,
        outcome,
        metadata,
      });
    } catch {
      // Must never disturb HTTP lifecycle
    }
  };
}
