/**
 * Group membership and admin permission middleware guards for restricted routes (#549, #808).
 *
 * Implements reusable Fastify preHandler middleware guards to enforce group
 * membership and admin privileges consistently across group management, treasury,
 * and expense mutation endpoints.
 *
 * Guards inspect request parameters (e.g. `id` or `groupId`) and authenticated user context
 * to verify database membership and roles:
 *   - requireGroupMember / requireMembershipGuard: ensures the caller is at least a member (or admin).
 *   - requireGroupAdmin / requireAdminGuard: ensures the caller holds the admin role.
 *   - requireExpensePayerOrAdmin / requireExpenseMutationRole: ensures the caller is either
 *     the creator/payer of the expense or an administrator of the owning group.
 *
 * Both accept `active: true`, which additionally rejects an archived group
 * (issue #648). Mutating group management routes set it; reads, leaving, and
 * archiving itself deliberately do not, so an archived group's history stays
 * readable and a member who no longer has an active role can still exit.
 *
 * Authorization failures return:
 *   - 401 Unauthorized when unauthenticated
 *   - 403 Forbidden when caller is not a member or lacks required privileges
 *   - 404 Not Found when the target group or expense does not exist
 */
import type { FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import {
  requireGroupRole,
  groupMembership,
  GROUP_GUARD,
  type GroupRole,
  type GroupIdParam,
} from "../plugins/group-access";
import {
  requireMembership,
  requireAdmin,
  requireActiveMembership,
  requireActiveAdmin,
  type MembershipContext,
} from "../services/access";

export interface GroupGuardOptions {
  /** The path parameter name containing the group ID (default: "id") */
  param?: GroupIdParam;
  /** Whether the parameter addresses an expense ID that owns the group */
  fromExpense?: boolean;
  /**
   * Require the group to be live (not archived). Set this on every route that
   * changes group state: archival closes a group to new state while its
   * history stays readable (issue #648). Read routes omit it, so members of an
   * archived group keep access to what it recorded.
   */
  active?: boolean;
}

/**
 * Fastify preHandler middleware guard enforcing that the authenticated caller
 * is an active member (or admin) of the group identified by the route parameter.
 */
export function requireGroupMember(
  options: GroupGuardOptions = {}
): preHandlerAsyncHookHandler {
  const param = options.param ?? "id";
  return requireGroupRole("member", {
    param,
    fromExpense: options.fromExpense,
    active: options.active,
  });
}

/**
 * Fastify preHandler middleware guard enforcing that the authenticated caller
 * is an administrator of the group identified by the route parameter.
 */
export function requireGroupAdmin(
  options: GroupGuardOptions = {}
): preHandlerAsyncHookHandler {
  const param = options.param ?? "id";
  return requireGroupRole("admin", {
    param,
    fromExpense: options.fromExpense,
    active: options.active,
  });
}

export interface ExpenseGuardOptions {
  /** The path parameter name containing the expense ID (default: "id") */
  param?: "id" | "expenseId";
  /** Require the owning group to be active (not archived). Default: true */
  active?: boolean;
}

/**
 * Fastify preHandler middleware guard enforcing that the authenticated caller
 * is either the payer (creator) of the expense or an administrator of the group owning the expense (#808).
 *
 * Ensures unauthorized users (non-members and non-payer/non-admin members) are rejected with
 * 403 Forbidden before reaching the route handler or opening transactions.
 */
export function requireExpensePayerOrAdmin(
  options: ExpenseGuardOptions = {}
): preHandlerAsyncHookHandler {
  const param = options.param ?? "id";
  const active = options.active !== false;

  const guard: preHandlerAsyncHookHandler = async function expensePayerOrAdminGuard(req: FastifyRequest) {
    const auth = requireUser(req);
    const params = (req.params ?? {}) as Record<string, string>;
    const expenseId = params[param];
    if (!expenseId) {
      throw Errors.badRequest("MISSING_ID", "Expense ID is required");
    }

    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      select: { id: true, groupId: true, payerUserId: true },
    });
    if (!expense) {
      throw Errors.notFound("Expense not found");
    }

    const membership = active
      ? await requireActiveMembership(expense.groupId, auth.id)
      : await requireMembership(expense.groupId, auth.id);

    req.groupMembership = membership;

    const isPayer = expense.payerUserId === auth.id;
    const isAdmin = membership.role === "admin";

    if (!isPayer && !isAdmin) {
      throw Errors.forbidden("Only the payer or an admin can modify or delete this expense");
    }
  };
  (guard as any)[GROUP_GUARD] = true;
  return guard;
}

// Aliases for explicit guard naming
export const requireMembershipGuard = requireGroupMember;
export const requireAdminGuard = requireGroupAdmin;
export const requireExpenseMutationRole = requireExpensePayerOrAdmin;
export const requireExpenseModificationGuard = requireExpensePayerOrAdmin;

/**
 * Role-based authorization guard for group management operations (#1137).
 *
 * Enforces that the caller is an admin of an *active* (non-archived) group
 * before they can perform write operations against group membership: removing a
 * member, promoting or demoting a member's role. Wraps `requireGroupAdmin` with
 * `active: true` so a single import conveys the full contract — "this route
 * mutates group membership and therefore requires both an admin role and a live
 * group".
 *
 * Usage:
 *   preHandler: requireGroupManagementGuard()
 *   preHandler: requireGroupManagementGuard({ param: "groupId" })
 */
export function requireGroupManagementGuard(
  options: Omit<GroupGuardOptions, "active"> = {}
): ReturnType<typeof requireGroupAdmin> {
  return requireGroupAdmin({ ...options, active: true });
}

/** Explicit alias: signals this is for member removal specifically. */
export const requireMemberRemovalGuard = requireGroupManagementGuard;
/** Explicit alias: signals this is for role modification specifically. */
export const requireRoleModificationGuard = requireGroupManagementGuard;

export {
  requireGroupRole,
  groupMembership,
  requireMembership,
  requireAdmin,
  type GroupRole,
  type GroupIdParam,
  type MembershipContext,
};

/**
 * Helper to retrieve the attached group member context from a request.
 */
export function groupMember(req: {
  groupMember?: MembershipContext;
  groupMembership?: MembershipContext;
}): MembershipContext | undefined {
  return req.groupMember ?? req.groupMembership;
}
