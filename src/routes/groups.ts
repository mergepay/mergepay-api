i = await tx.invitation.create({
          data: {
            groupId: id,
            inviteePublicKey: body.publicKey,
            status: "PENDING",
          },
        });

        maxUses: body.maxUses ?? null,
          expiresAt,
        },
      });
      typeauth.id,
          action: "group.join",
          entityType: "group",
          entityId: invite.groupId,
          metadata: { inviteId: invite.id },
        });
      });
    }

    const group = await prisma.group.findUnique({
      where: { id: invite.groupId },
    });
    return { group: serializeGroup(group) };
  });

  // -- leave ------------------------------------------------------------------
  app.post(
    "/groups/:id/leave",
    {
      schema: {
        tags: ["groups"],
        summary: "Leave a group",
        description: "Leave the group after the last-admin safety checks ensure the group remains administrable.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        response: { 200: { type: "object", properties: { ok: { type: "boolean" } } } },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);

    // The membership check, the last-admin guard, and the removal all run
    // inside one transaction so a concurrent leave/removal by another admin
    // can't race past the last-admin check and leave the group ownerless.
    await prisma.$transaction(async (tx) => {
      const ctx = await requireMembership(id, auth.id, tx);

      if (ctx.role === "admin") {
        const [adminCount, totalCount] = await Promise.all([
          tx.groupMember.count({ where: { groupId: id, role: "admin" } }),
          tx.groupMember.count({ where: { groupId: id } }),
        ]);
        if (adminCount === 1 && totalCount > 1) {
          throw Errors.conflict(
            "last_admin",
            "Promote another member to admin before leaving"
          );
        }
      }

      await tx.groupMember.delete({
        where: { groupId_userId: { groupId: id, userId: auth.id } },
      });
      await auditTx(tx, {
        userId: auth.id,
        action: "group.leave",
        entityType: "group",
        entityId: id,
      });
    });
    return { ok: true };
  });

  // -- remove member ---------------------------------------------------------
 === "admin") {
        const adminCount = await tx.groupMember.count({
          where: { groupId: id, role: "admin" },
        });
        if (adminCount <= 1) {
          throw Errors.conflict(
            "last_admin",
            "Cannot remove the last admin from the group"
          );
        }
      }

      await tx.groupMember.delete({
        where: { groupId_userId: { groupId: id, userId: memberId } },
      });

      await auditTx(tx, {
        userId: auth.id,
        groupId: id,
        action: AuditAction.GROUP_MEMBER_REMOVE,
        entityType: "group",
        entityId: id,
        outcome: "success",
        metadata: { removedUserId: memberId, removedRole: target.role },
      });
    });

    return { ok: true };
  });

  /**
   * Change a member's role.
   *
   * The membership read, the last-admin guard, the update, and the audit
   * record all run in one transaction. That matters in both directions: a
   * concurrent demotion cannot slip past the guard and leave a group with no
   * admin, and the audit entry cannot survive a rolled-back change (or be
   * lost while the change commits). `auditTx` deliberately does not swallow
   * errors, so a failed audit write rolls the role change back with it.
   */
  app.post(
    "/groups/:id/members/role",
    {
      schema: {
        tags: ["groups"],
        summary: "Update a member role",
        description: "Promote or demote a group member while enforcing the last-admin protection rules.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        body: {
          type: "object",
          required: ["userId", "role"],
          properties: {
            userId: { type: "string", minLength: 1, maxLength: 64 },
            role: { type: "string", enum: ["admin", "member"] },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              member: {
                type: "object",
                required: ["userId", "role"],
                properties: {
                  userId: { type: "string" },
                  role: { type: "string", enum: ["admin", "member"] },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z
        .object({
          userId: z.string().min(1).max(64),
          role: z.enum(["admin", "member"]),
        })
        .parse(req.body);

    const updated = await prisma.$transaction(async (tx) => {
      // Authorization is re-checked inside the transaction so a concurrent
      // demotion of the caller cannot let an ex-admin land one last write.
      await requireAdmin(id, auth.id, tx);

      const target = await tx.groupMember.findUnique({
        where: { groupId_userId: { groupId: id, userId: body.userId } },
      });
      if (!target) {
        throw Errors.notFound("Member not found in this group");
      }

      if (target.role === body.role) {
        // Nothing changed, so there is nothing to audit. Returning the current
        // membership keeps the endpoint idempotent for a retried request.
        return target;
      }

      // Demoting the last admin would leave the group unadministrable, with
      // no one able to promote anyone back.
      if (target.role === "admin" && body.role !== "admin") {
        const adminCount = await tx.groupMember.count({
          where: { groupId: id, role: "admin" },
        });
        if (adminCount <= 1) {
          throw Errors.conflict(
            "last_admin",
            "Cannot demote the last admin of the group"
          );
        }
      }

      const result = await tx.groupMember.update({
        where: { groupId_userId: { groupId: id, userId: body.userId } },
        data: { role: body.role },
      });

      await auditTx(tx, {
        userId: auth.id,
        groupId: id,
        action: "group.member_role_change",
        entityType: "group_member",
        entityId: body.userId,
        outcome: "success",
        metadata: {
          targetUserId: body.userId,
          previousRole: target.role,
          newRole: body.role,
        },
      });

      return result;
    });

    return { member: { userId: updated.userId, role: updated.role } };
  });

  // -- archive ----------------------------------------------------------------
  app.post(
    "/groups/:id/archive",
    {
      schema: {
        tags: ["groups"],
        summary: "Archive a group",
        description: "Archive a group so it is no longer active while preserving its data and membership history.",
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string", minLength: 1 } },
          additionalProperties: false,
        },
        response: {
          200: {
            type: "object",
            properties: {
              group: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  description: { type: ["string", "null"] },
                  createdByUserId: { type: "string" },
                  treasuryEnabled: { type: "boolean" },
                  treasuryAccountPublicKey: { type: ["string", "null"] },
                  treasuryRequiredSigners: { type: ["integer", "null"] },
                  archived: { type: "boolean" },
                  createdAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);

    const group = await prisma.$transaction(async (tx) => {
      await requireAdmin(id, auth.id, tx);
      const updated = await tx.group.update({
        where: { id },
        data: { archived: true },
      });
      await auditTx(tx, {
        userId: auth.id,
        action: "group.archive",
        entityType: "group",
        entityId: id,
      });
      return updated;
    });
    return { group: serializeGroup(group) };
  });
}
