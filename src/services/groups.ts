import { Errors } from "../errors";
import {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupCurrency,
} from "../schemas/groups";
import {
  requireMembership,
  requireAdmin,
  requireActiveAdmin,
  type MembershipContext,
} from "./access";
import { audit, auditGroupMemberActionTx } from "./audit";
import { AuditAction } from "./audit-actions";
import { prisma } from "../db";

/**
 * Validate a group creation request payload against the Zod schema.
 * Throws AppError 400 Bad Request on validation failure with a clear message.
 */
export function validateCreateGroupPayload(payload: unknown): CreateGroupInput {
  const result = createGroupSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const pathStr = issue?.path.join(".") || "payload";
    throw Errors.badRequest("VALIDATION_ERROR", `${pathStr}: ${issue?.message ?? "Invalid group payload"}`);
  }
  return result.data;
}

/**
 * Validate a group update request payload against the Zod schema.
 * Throws AppError 400 Bad Request on validation failure with a clear message.
 */
export function validateUpdateGroupPayload(payload: unknown): UpdateGroupInput {
  const result = updateGroupSchema.safeParse(payload);
  if (!result.success) {
    const issue = result.error.issues[0];
    const pathStr = issue?.path.join(".") || "payload";
    throw Errors.badRequest("VALIDATION_ERROR", `${pathStr}: ${issue?.message ?? "Invalid group update payload"}`);
  }
  return result.data;
}

/**
 * Verify that a user is an administrator of a group for sensitive treasury operations (#908).
 *
 * Checks database membership and admin role. If authorized, records an audit log
 * and returns the MembershipContext. If unauthorized, records a failed audit attempt
 * and throws AppError 403 Forbidden (or 404 if the group doesn't exist).
 */
export async function assertGroupAdmin(
  userId: string,
  groupId: string,
  options: { active?: boolean } = {}
): Promise<MembershipContext> {
  try {
    const ctx = options.active
      ? await requireActiveAdmin(groupId, userId, prisma)
      : await requireAdmin(groupId, userId, prisma);

    return ctx;
  } catch (err) {
    // Record audit event for unauthorized or failed access attempt
    void audit({
      userId,
      groupId,
      action: "treasury.signer_validation",
      entityType: "group_treasury",
      entityId: groupId,
      outcome: "failure",
      metadata: {
        error: err instanceof Error ? err.message : "unauthorized",
        attemptedRole: "admin",
      },
    });
    throw err;
  }
}

export {
  createGroupSchema,
  updateGroupSchema,
  GROUP_CURRENCIES,
  groupCurrencySchema,
  type CreateGroupInput,
  type UpdateGroupInput,
  type GroupCurrency,
};


export interface ModifyGroupMemberRoleOptions {
  actorUserId: string;
  groupId: string;
  targetUserId: string;
  newRole: "admin" | "member";
  tx?: any;
}

export interface ModifyGroupMemberRoleResult {
  userId: string;
  groupId: string;
  previousRole: string;
  newRole: string;
  changed: boolean;
}

/**
 * Modify a group member's role with mandatory audit logging and last-admin protection (#876).
 *
 * Atomically verifies authorization, enforces the last-admin invariant, updates the role,
 * and records a GROUP_MEMBER_ROLE_CHANGE audit entry with previous and new roles.
 */
export async function modifyGroupMemberRole(
  options: ModifyGroupMemberRoleOptions
): Promise<ModifyGroupMemberRoleResult> {
  const { actorUserId, groupId, targetUserId, newRole } = options;

  const runWithTx = async (tx: any) => {
    await requireAdmin(groupId, actorUserId, tx);

    const target = await tx.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });
    if (!target) {
      throw Errors.notFound("Member not found in this group");
    }

    if (target.role === newRole) {
      return {
        userId: targetUserId,
        groupId,
        previousRole: target.role,
        newRole,
        changed: false,
      };
    }

    if (target.role === "admin" && newRole !== "admin") {
      const adminCount = await tx.groupMember.count({
        where: { groupId, role: "admin" },
      });
      if (adminCount <= 1) {
        throw Errors.conflict("LAST_ADMIN", "Cannot remove the only admin from a group");
      }
    }

    const updated = await tx.groupMember.update({
      where: { groupId_userId: { groupId, userId: targetUserId } },
      data: { role: newRole },
    });

    await auditGroupMemberActionTx(tx, {
      userId: actorUserId,
      groupId,
      memberId: targetUserId,
      action: AuditAction.GROUP_MEMBER_ROLE_CHANGE,
      metadata: {
        targetUserId,
        previousRole: target.role,
        newRole,
      },
    });

    return {
      userId: updated.userId,
      groupId,
      previousRole: target.role,
      newRole: updated.role,
      changed: true,
    };
  };

  if (options.tx) {
    return runWithTx(options.tx);
  }
  return prisma.$transaction((tx: any) => runWithTx(tx));
}

export interface RemoveGroupMemberOptions {
  actorUserId: string;
  groupId: string;
  targetUserId: string;
  correlationId?: string | null;
  tx?: any;
}

export interface RemoveGroupMemberResult {
  userId: string;
  groupId: string;
  removedRole: string;
}

/**
 * Remove a member from a group with mandatory audit logging and last-admin protection (#868).
 *
 * Atomically verifies authorization (actor must be admin), enforces the last-admin invariant,
 * prevents self-removal, deletes membership, and records a GROUP_MEMBER_REMOVE audit log entry.
 */
export async function removeGroupMember(
  options: RemoveGroupMemberOptions
): Promise<RemoveGroupMemberResult> {
  const { actorUserId, groupId, targetUserId, correlationId } = options;

  if (targetUserId === actorUserId) {
    throw Errors.badRequest(
      "SELF_REMOVE",
      "Cannot remove yourself from the group; use the leave endpoint instead"
    );
  }

  const runWithTx = async (tx: any) => {
    await requireAdmin(groupId, actorUserId, tx);

    const target = await tx.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });
    if (!target) {
      throw Errors.notFound("Member not found in this group");
    }

    if (target.role === "admin") {
      const adminCount = await tx.groupMember.count({
        where: { groupId, role: "admin" },
      });
      if (adminCount <= 1) {
        throw Errors.conflict(
          "last_admin",
          "Cannot remove the last admin from the group"
        );
      }
    }

    await tx.groupMember.delete({
      where: { groupId_userId: { groupId, userId: targetUserId } },
    });

    await auditGroupMemberActionTx(tx, {
      correlationId: correlationId ?? null,
      userId: actorUserId,
      groupId,
      memberId: targetUserId,
      action: AuditAction.GROUP_MEMBER_REMOVE,
      metadata: {
        targetUserId,
        removedRole: target.role,
      },
    });

    return {
      userId: targetUserId,
      groupId,
      removedRole: target.role,
    };
  };

  if (options.tx) {
    return runWithTx(options.tx);
  }
  return prisma.$transaction((tx: any) => runWithTx(tx));
}
