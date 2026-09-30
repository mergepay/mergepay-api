/**
 * Group membership and admin permission middleware guards for restricted routes (#549).
 *
 * Implements reusable Fastify preHandler middleware guards to enforce group
 * membership and admin privileges consistently across group management and treasury endpoints.
 *
 * Guards inspect request parameters (e.g. `id` or `groupId`) and authenticated user context
 * to verify database membership and roles:
 *   - requireGroupMember / requireMembershipGuard: ensures the caller is at least a member (or admin).
 *   - requireGroupAdmin / requireAdminGuard: ensures the caller holds the admin role.
 *
 * Authorization failures return:
 *   - 401 Unauthorized when unauthenticated
 *   - 403 Forbidden when caller is not a member or lacks admin privileges
 *   - 404 Not Found when the target group does not exist
 */
import type { preHandlerAsyncHookHandler } from "fastify";
import {
  requireGroupRole,
  groupMembership,
  type GroupRole,
  type GroupIdParam,
} from "../plugins/group-access";
import {
  requireMembership,
  requireAdmin,
  type MembershipContext,
} from "../services/access";

export interface GroupGuardOptions {
  /** The path parameter name containing the group ID (default: "id") */
  param?: GroupIdParam;
  /** Whether the parameter addresses an expense ID that owns the group */
  fromExpense?: boolean;
}

/**
 * Fastify preHandler middleware guard enforcing that the authenticated caller
 * is an active member (or admin) of the group identified by the route parameter.
 */
export function requireGroupMember(
  options: GroupGuardOptions = {}
): preHandlerAsyncHookHandler {
  const param = options.param ?? "id";
  return requireGroupRole("member", { param, fromExpense: options.fromExpense });
}

/**
 * Fastify preHandler middleware guard enforcing that the authenticated caller
 * is an administrator of the group identified by the route parameter.
 */
export function requireGroupAdmin(
  options: GroupGuardOptions = {}
): preHandlerAsyncHookHandler {
  const param = options.param ?? "id";
  return requireGroupRole("admin", { param, fromExpense: options.fromExpense });
}

// Aliases for explicit guard naming
export const requireMembershipGuard = requireGroupMember;
export const requireAdminGuard = requireGroupAdmin;

export {
  requireGroupRole,
  groupMembership,
  requireMembership,
  requireAdmin,
  type GroupRole,
  type GroupIdParam,
  type MembershipContext,
};
