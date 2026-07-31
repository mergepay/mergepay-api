import { prisma } from "../db";
import { Errors } from "../errors";

export interface MembershipContext {
  groupId: string;
  userId: string;
  role: string;
}

/**
 * Ensure the user is currently a member of the group; returns their membership
 * row.
 *
 * A caller who is not a member gets `403 FORBIDDEN` when the group exists and
 * `404 NOT_FOUND` when it does not. The distinction is deliberate — clients
 * need to tell "this resource is gone" from "you may not look at it" to render
 * a useful state — and it leaks only group-id existence, never any group
 * content, membership, or balance.
 */
export async function requireMembership(
  groupId: string,
  userId: string
): Promise<MembershipContext> {
  const member = await prisma.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });

  if (!member) {
    const group = await prisma.group.findUnique({
      where: { id: groupId },
      select: { id: true },
    });
    if (!group) throw Errors.notFound("Group not found");
    throw Errors.forbidden("You are not a member of this group");
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
