/**
 * Group authorization guards — issue #356.
 *
 * Two reusable preHandler factories enforce the project's two authorization
 * rules at the HTTP layer, before a route handler runs a single line:
 *
 *   `app.groupMemberGuard()`  the caller must be a member of the target group
 *   `app.groupAdminGuard()`   the caller must be an admin of the target group
 *
 * Both delegate to `requireMembership` / `requireAdmin` in
 * `src/services/access.ts`, so the policy is defined in exactly one place:
 * the same 403-for-non-members, 404-for-unknown-groups distinction, and
 * database-sourced role the rest of the codebase already relies on. The role
 * is always read from the membership row — never from the request — so a
 * caller cannot talk their way into admin.
 *
 * Guards are additive to the in-transaction checks the handlers keep.
 * A preHandler runs outside the handler's `prisma.$transaction`, so it can
 * fail a request early (cheaply, and before any handler-side read or write)
 * but it can never be the atomic check-and-write pair a mutation needs.
 * Handlers therefore still re-check inside their transaction — see the
 * atomicity comments in src/routes/groups.ts and src/routes/expenses.ts and
 * tests/authorization-atomicity.test.ts. A denial from either layer produces
 * the identical 403 response.
 *
 * Wiring: instance-level hooks registered with `addHook` run before
 * route-level hooks (Fastify concatenates them in that order), and every
 * route plugin registers `app.authenticate` as an instance-level preHandler.
 * A guard therefore always sees an authenticated `req.user`; the belt-and-
 * braces `requireUser` call covers a route that forgets to authenticate.
 */
import {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  preHandlerAsyncHookHandler,
} from "fastify";
import fp from "fastify-plugin";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireAdmin, requireMembership } from "../services/access";
import { requireUser } from "./auth";

/** Extracts the id of the group a request is addressing. */
export type GroupIdResolver = (req: FastifyRequest) => string | Promise<string>;

export interface GroupGuardOptions {
  /**
   * How the guard finds the group for this route. Defaults to `params.id`,
   * which every `/groups/:id/...` route uses; routes addressed by another
   * resource (such as `/expenses/:id`) pass a resolver that maps the
   * resource back to its group.
   */
  groupId?: GroupIdResolver;
}

/**
 * Default resolver for `/groups/:id/...` routes.
 *
 * A request that reaches a guard without a group id in its params can only
 * come from a route misconfigured with the guard; failing loudly there is
 * safer than checking an undefined group.
 */
const groupIdFromParams: GroupIdResolver = (req) => {
  const params = (req.params ?? {}) as { id?: string; groupId?: string };
  const groupId = params.groupId ?? params.id;
  if (!groupId) {
    throw Errors.badRequest("missing_group_id", "This route does not address a group");
  }
  return groupId;
};

/**
 * Resolver for routes addressed by a single expense id: the group is a
 * property of the expense row, not of the URL, so the row is read first.
 *
 * The lookup deliberately selects only `groupId` — the guard has no business
 * loading payer, shares, or amounts — and preserves the route's own 404 for
 * an unknown expense, so callers cannot tell where the lookup happened.
 */
export async function groupIdFromExpense(req: FastifyRequest): Promise<string> {
  const { id } = (req.params ?? {}) as { id?: string };
  const expense = id
    ? await prisma.expense.findUnique({ where: { id }, select: { groupId: true } })
    : null;
  if (!expense) throw Errors.notFound("Expense not found");
  return expense.groupId;
}

/**
 * Shared guard body: authenticate-derived user + resolved group id + the
 * shared policy check. Throwing an `AppError` from a preHandler is what the
 * error handler turns into the 403/404 response.
 */
async function authorize(
  req: FastifyRequest,
  resolve: GroupIdResolver,
  admin: boolean
): Promise<void> {
  const user = requireUser(req);
  const groupId = await resolve(req);
  if (admin) {
    await requireAdmin(groupId, user.id);
  } else {
    await requireMembership(groupId, user.id);
  }
}

async function authorizationPlugin(app: FastifyInstance) {
  app.decorate(
    "groupMemberGuard",
    function groupMemberGuard(options: GroupGuardOptions = {}): preHandlerAsyncHookHandler {
      const resolve = options.groupId ?? groupIdFromParams;
      return async function memberGuard(req: FastifyRequest, _reply: FastifyReply) {
        await authorize(req, resolve, false);
      };
    }
  );

  app.decorate(
    "groupAdminGuard",
    function groupAdminGuard(options: GroupGuardOptions = {}): preHandlerAsyncHookHandler {
      const resolve = options.groupId ?? groupIdFromParams;
      return async function adminGuard(req: FastifyRequest, _reply: FastifyReply) {
        await authorize(req, resolve, true);
      };
    }
  );
}

declare module "fastify" {
  interface FastifyInstance {
    groupMemberGuard(options?: GroupGuardOptions): preHandlerAsyncHookHandler;
    groupAdminGuard(options?: GroupGuardOptions): preHandlerAsyncHookHandler;
  }
}

export default fp(authorizationPlugin, { name: "authorization" });
