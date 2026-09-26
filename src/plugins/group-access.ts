/**
 * Route-level authorization for group-scoped endpoints.
 *
 * Every route addressed by a group id in its path (`/groups/:id/...`,
 * `/groups/:groupId/...`) declares the role it needs with
 * `requireGroupRole(role, { param })` as its `preHandler`. The guard runs
 * after `app.authenticate` and before the handler, so a caller who is not a
 * member — or lacks the role — gets 403 before any body is parsed, any
 * upstream (Horizon) call is made, or any business logic runs.
 *
 * Escalation-safety rules the guard enforces by construction:
 *
 *  - the group id comes only from the named *path* parameter — never from the
 *    query string or body, which the caller could point at a different group;
 *  - the role comes only from the database membership row (via
 *    `src/services/access.ts`) — never from the token or request data;
 *  - a membership row with any role other than `admin` never satisfies an
 *    admin requirement.
 *
 * The resolved membership is attached as `req.groupMembership` for handlers
 * that need the caller's role (read it with {@link groupMembership}).
 *
 * Mutating routes that already re-run `requireAdmin` / `requireMembership`
 * inside their Prisma transaction keep doing so: that re-check closes the
 * window in which a concurrent demotion or removal could land between this
 * guard and the write (see tests/authorization-atomicity.test.ts). Both
 * checks go through the same functions in `src/services/access.ts`, so the
 * authorization rule itself lives in exactly one place.
 */
import type {
  FastifyInstance,
  FastifyRequest,
  RouteOptions,
  preHandlerAsyncHookHandler,
} from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { requireUser } from "./auth";
import {
  requireAdmin,
  requireMembership,
  type MembershipContext,
} from "../services/access";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by `requireGroupRole` once the caller's membership is verified. */
    groupMembership?: MembershipContext;
  }
}

/** Roles a group route can require. `admin` implies `member`. */
export type GroupRole = "member" | "admin";

/** Path parameters that carry a group id on the existing routes. */
export type GroupIdParam = "id" | "groupId";

/** Group ids are cuids; 64 is the ceiling the routes already validate against. */
const groupIdSchema = z.string().min(1).max(64);

/** Marks a preHandler produced by `requireGroupRole`, so the plugin can order it. */
const GROUP_GUARD = Symbol("mergepay.groupGuard");

type MarkedGuard = preHandlerAsyncHookHandler & { [GROUP_GUARD]?: true };

function isGroupGuard(fn: unknown): boolean {
  return typeof fn === "function" && (fn as MarkedGuard)[GROUP_GUARD] === true;
}

/**
 * Build a `preHandler` that verifies the authenticated caller holds `role` in
 * the group named by the `param` path parameter.
 *
 * - no authenticated user → 401 (defensive; `app.authenticate` runs first)
 * - missing / malformed group id → 400 VALIDATION_ERROR
 * - group does not exist → 404 NOT_FOUND
 * - caller not a member, or member without the required role → 403 FORBIDDEN
 */
export function requireGroupRole(
  role: GroupRole,
  opts: { param: GroupIdParam }
): preHandlerAsyncHookHandler {
  const paramsSchema = z.object({ [opts.param]: groupIdSchema });
  const check = role === "admin" ? requireAdmin : requireMembership;

  const guard: MarkedGuard = async function groupRoleGuard(req: FastifyRequest) {
    const auth = requireUser(req);
    const groupId = paramsSchema.parse(req.params ?? {})[opts.param] as string;
    req.groupMembership = await check(groupId, auth.id);
  };
  guard[GROUP_GUARD] = true;
  return guard;
}

/**
 * Keeps group guards last in each route's `preHandler` chain.
 *
 * `@fastify/rate-limit` attaches `preHandler`-hooked limits (the user-keyed
 * policies, which need `req.user`) by *appending* to the route's
 * `preHandler` array in its own `onRoute` hook. A guard declared in route
 * options would therefore run before the limiter, and every request the
 * guard rejects — non-members probing group ids — would cost a membership
 * query without ever counting against the budget.
 *
 * This plugin's `onRoute` hook runs after the limiter's (it is registered
 * after it in src/app.ts) and moves every guard to the end, giving the
 * effective order: authenticate → rate limit → group guard → handler.
 */
export default fp(async function groupAccessPlugin(app: FastifyInstance) {
  app.addHook("onRoute", (routeOptions: RouteOptions) => {
    const chain = routeOptions.preHandler;
    if (!Array.isArray(chain) || !chain.some(isGroupGuard)) return;
    routeOptions.preHandler = [
      ...chain.filter((fn) => !isGroupGuard(fn)),
      ...chain.filter(isGroupGuard),
    ];
  });
});

/**
 * The membership `requireGroupRole` verified for this request.
 *
 * Throws if the route forgot to declare the guard — a programming error that
 * must fail loudly (500) rather than silently skip authorization.
 */
export function groupMembership(req: FastifyRequest): MembershipContext {
  if (!req.groupMembership) {
    throw new Error("groupMembership() read on a route without requireGroupRole");
  }
  return req.groupMembership;
}
