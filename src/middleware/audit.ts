/**
 * Structured audit logging middleware — issue #914.
 *
 * A route-level `onResponse` hook factory that gives a state-changing
 * endpoint an audit record without its handler having to write one itself.
 * Handlers that already write a richer, in-transaction row (`auditTx` /
 * `logActionTx` / `auditGroupMemberActionTx`) keep doing so — that row commits
 * with the mutation and can never survive a rollback. This middleware is the
 * declarative path for the endpoints where no such transaction exists and
 * "the request succeeded" *is* the state change (a profile update, a queued
 * webhook test delivery).
 *
 * Why `onResponse`, and why that satisfies the issue's requirements:
 *
 *  - **Zero latency cost.** The hook runs only after the reply has been sent,
 *    so the audit write is physically unable to add to request duration. The
 *    write is scheduled through {@link logAuditTrail} and never awaited.
 *  - **Only real state changes are recorded.** Non-state-changing methods
 *    (GET/HEAD/OPTIONS) and any reply outside 2xx are skipped: a rejected call
 *    changed nothing, and a trail that says otherwise is worse than no trail.
 *  - **Request context without secrets.** The actor comes from `req.user`,
 *    the target from the route's own params, and the metadata is the matched
 *    route *pattern* plus whatever field **names** a caller opts into. Headers,
 *    tokens, bodies, and XDRs are never read here, and everything that does
 *    reach the row still passes through `sanitizeAuditMetadata`
 *    (src/lib/audit-logger.ts) on the way out.
 *
 * Failures never surface: the hook swallows its own errors (the response is
 * already delivered by the time it runs), and the write itself is best-effort.
 */
import type {
  FastifyReply,
  FastifyRequest,
  onResponseHookHandler,
} from "fastify";
import {
  logAuditTrail,
  type AuditActorType,
  type AuditOutcome,
} from "../services/audit";

/** HTTP methods that can change state. Reads never reach the writer. */
export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export interface AuditTrailOptions {
  /** Action type from the structured vocabulary (src/services/audit-actions.ts). */
  action: string;
  /** Target resource type, e.g. "user", "webhook", "group". */
  resourceType: string;
  /**
   * Target resource id, resolved from the finished request — normally from
   * `req.user` or the route params. A falsy result is recorded as
   * `"unknown"` rather than dropped, so a request that succeeded is never
   * silently absent from the trail.
   */
  resourceId: (req: FastifyRequest) => string | null | undefined;
  /** Group the change belongs to, when it is group-scoped. */
  groupId?: (req: FastifyRequest) => string | null | undefined;
  /** Defaults to `"user"` for an authenticated caller, `"system"` otherwise. */
  actorType?: AuditActorType;
  /** Outcome recorded on the row; defaults to `"success"` (only 2xx reach it). */
  outcome?: AuditOutcome;
  /**
   * Extra safe detail — identifiers and field *names* only, never values,
   * headers, or tokens. Merged over the default `{ method, route }` metadata.
   */
  metadata?: (req: FastifyRequest) => Record<string, unknown>;
}

/**
 * Build the `onResponse` hook that records one state change.
 *
 * Attach it to a route alongside its other options:
 *
 * ```ts
 * app.patch("/me", {
 *   preHandler: [app.authenticate],
 *   onResponse: auditTrail({
 *     action: "user.profile.update",
 *     resourceType: "user",
 *     resourceId: (req) => req.user?.id ?? null,
 *   }),
 * }, handler);
 * ```
 */
export function auditTrail(
  options: AuditTrailOptions
): onResponseHookHandler {
  return function auditTrailHook(
    this: unknown,
    req: FastifyRequest,
    reply: FastifyReply,
    done: () => void
  ): void {
    // Release the request lifecycle first: nothing below may be able to hold
    // the reply (already sent) or the hook chain open.
    done();
    try {
      if (!STATE_CHANGING_METHODS.has(req.method)) return;
      if (reply.statusCode < 200 || reply.statusCode >= 300) return;

      const actorId = req.user?.id ?? null;
      logAuditTrail({
        correlationId: req.id,
        actorId,
        actorType: options.actorType ?? (actorId ? "user" : "system"),
        groupId: options.groupId?.(req) ?? null,
        action: options.action,
        resourceType: options.resourceType,
        resourceId: options.resourceId(req) || "unknown",
        outcome: options.outcome ?? "success",
        metadata: {
          method: req.method,
          // The registered route pattern (`/api/v1/me`), never the raw URL:
          // a pattern carries no caller-supplied query or path values.
          route: req.routeOptions.url ?? null,
          ...(options.metadata?.(req) ?? {}),
        },
      });
    } catch {
      // Observational only — a resolver that throws must not disturb a
      // response that has already been delivered, nor the process.
    }
  };
}
