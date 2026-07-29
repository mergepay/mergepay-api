import { prisma } from "../db";
import { Errors } from "../errors";

export interface MembershipContext {
  groupId: string;
  userId: string;
  role: string;
}

/**
 * Ensure the user is currently a member of the group; returns their membership
 * row. A missing membership is intentionally reported as not-found so callers
 * cannot use an authenticated token to determine whether another group exists.
 */
export async function requireMembership(
  groupId: string,
  userId: string
): Promise<MembershipContext> {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });

  if (!member) {
    throw Errors.notFound("Group not found");
  }

  return { groupId, userId, role: member.role };
}

/**
 * Ensure the user is currently an administrator of the group. The role is
 * always read from the database membership row and is never taken from
 * request data.
 */
export async function requireAdmin(
  groupId: string,
  userId: string
): Promise<MembershipContext> {
  const ctx = await requireMembership(groupId, userId);
  if (ctx.role !== "admin") {
    throw Errors.forbidden("Only a group admin can perform this action");
  }
  return ctx;
}
