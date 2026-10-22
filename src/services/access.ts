import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../db";
import { Errors } from "../errors";

export interface MembershipContext {
  groupId: string;
  userId: string;
  role: string;
}

/**
 * Any client capable of running the membership lookup: the default
 * singleton, or a `prisma.$transaction` callback's `tx`. Passing `tx`
 * lets a route perform its authorization check and its mutation as one
 * atomic unit, so a concurrent membership change (removal, demotion)
 * between the check and the write cannot slip through.
 */
type Db = PrismaClient | Prisma.TransactionClient;

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
  userId: string,
  db: Db = prisma
): Promise<MembershipContext> {
  const member = await db.groupMember.findUnique({
    where: { groupId_userId: { groupId, userId } },
  });

  if (!member) {
    const group = await db.group.findUnique({
      where: { id: groupId },
      select: { id: true, archived: true },
    });
    if (!group) throw Errors.notFound("Group not found");
    if (group.archived) throw Errors.forbidden("Group is archived");
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
  userId: string,
  db: Db = prisma
): Promise<MembershipContext> {
  const ctx = await requireMembership(groupId, userId, db);
  if (ctx.role !== "admin") {
    throw Errors.forbidden("Only a group admin can perform this action");
  }
  return ctx;
}

/**
 * Reject a mutation against a group that has been archived.
 *
 * `requireMembership` deliberately lets a member of an archived group through:
 * archival closes a group to *new* state but its history must stay readable
 * (issue #648). Writes have no such exemption, so every route whose next
 * statement changes group state asserts this on top of the membership check.
 *
 * Throws only when the group is positively `archived`. A missing row is not
 * "archived" — `requireMembership` has already returned `404` for that caller,
 * and a `null` here is a mock's silence, not a closed group.
 */
async function assertGroupActive(groupId: string, db: Db): Promise<void> {
  const group = await db.group.findUnique({
    where: { id: groupId },
    select: { archived: true },
  });
  if (group?.archived) throw Errors.forbidden("Group is archived");
}

/**
 * Membership *and* a live (non-archived) group — the requirement to mutate
 * group state. Same caller contract as {@link requireMembership}; use this on
 * routes that write, the passive one on routes that only read.
 */
export async function requireActiveMembership(
  groupId: string,
  userId: string,
  db: Db = prisma
): Promise<MembershipContext> {
  const ctx = await requireMembership(groupId, userId, db);
  await assertGroupActive(groupId, db);
  return ctx;
}

/**
 * Admin role *and* a live group — the admin-write counterpart of
 * {@link requireActiveMembership}.
 */
export async function requireActiveAdmin(
  groupId: string,
  userId: string,
  db: Db = prisma
): Promise<MembershipContext> {
  const ctx = await requireAdmin(groupId, userId, db);
  await assertGroupActive(groupId, db);
  return ctx;
}
