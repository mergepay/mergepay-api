
  : }
        }),
      },
      id } = z.object({ id: z.string() }).parse(req.params);

    // Direct invitation by Stellar public key
    if (
      typeof req.body === "object" &&
      req.body &&
      "publicKey" in req.body
    ) {
      const body = z
        .object({
          publicKey: stellarAccountIdSchema,
        })
        .parse(req.body);

      // The admin check and the invitation write happen inside one
      // transaction so a concurrent demotion/removal of `auth.id` between
      // the check and the write cannot let a former admin sneak an
      // invitation through.
      const invitation = await prisma.$transaction(async (tx) => {
        await requireAdmin(id, auth.id, tx);

        // Check if invitee is already a member
        const inviteeUser = await tx.user.findUnique({
          where: { stellarPublicKey: body.publicKey },
        });
        if (inviteeUser) {
          const existingMember = await tx.groupMember.findUnique({
            where: {
              groupId_userId: { groupId: id, userId: inviteeUser.id },
            },
          });
          if (existingMember) {
            throw Errors.conflict(
              "ALREADY_MEMBER",
              "This user is already a member of the group"
            );
          }
        }

        // Check for existing pending invitation
        const existingInvitation = await tx.invitation.findFirst({
          where: {
            groupId: id,
            inviteePublicKey: body.publicKey,
            status: "PENDING",
          },
        });
        if (existingInvitation) {
          throw Errors.conflict(
            "INVITATION_PENDING",
            "An invitation for this user is already pending"
          );
        }

        const created = await tx.invitation.create({
          data: {
            groupId: id,
            inviteePublicKey: body.publicKey,
            status: "PENDING",
          },
        });

        await auditTx(tx, {
          userId: auth.id,
          action: "group.invite",
          entityType: "invitation",
          entityId: created.id,
          metadata: { groupId: id, inviteePublicKey: body.publicKey },
        });

        return created;
      });

      return reply.status(201).send({ invitation: serializeInvitation(invitation) });
    }

    // Legacy invite code generation
    const body = z
      .object({
        maxUses: z.number().int().positive().optional(),
        expiresInHours: z.number().int().positive().optional(),
      })
      .parse(req.body ?? {});

    const expiresAt = body.expiresInHours
      ? new Date(Date.now() + body.expiresInHours * 3600_000)
      : null;

    const invite = await prisma.$transaction(async (tx) => {
      await requireAdmin(id, auth.id, tx);
      const created = await tx.invite.create({
        data: {
          groupId: id,
          code: inviteCode(),
          createdByUserId: auth.id,
          maxUses: body.maxUses ?? null,
          expiresAt,
        },
      });
      await auditTx(tx, {
        userId: auth.id,
        action: "group.invite_code_create",
        entityType: "invite",
        entityId: created.id,
        metadata: { groupId: id },
      });
      return created;
    });
    return { invite: serializeInvite(invite, config.WEB_URL) };
  });

  // -- join -------------------------------------------------------------------
  app.post(
    "/groups/join",
    {
      schema: {
        tags: ["groups"],
        summary: "Join a group with an invite code",
        description: "Join a group using a valid invite code, checking expiration and usage limits before adding the member.",
        body: {
          type: "object",
          required: ["code"],
          properties: { code: { type: "string", minLength: 1 } },
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
      const body = z.object({ code: z.string().min(1) }).parse(req.body);

    const invite = await prisma.invite.findUnique({
      where: { code: body.code.toUpperCase() },
    });
    if (!invite) throw Errors.notFound("Invite not found");
    if (invite.expiresAt && invite.expiresAt < new Date()) {
      throw Errors.badRequest("invite_expired", "This invite has expired");
    }
    if (invite.maxUses != null && invite.uses >= invite.maxUses) {
      throw Errors.badRequest("invite_used_up", "This invite has reached its use limit");
    }

    const = requireUser(req);
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
= requireUser(req);
    const { id, memberId } = z.object({ id: z.string(), memberId: z.string() }).parse(req.params);
    const body = z.object({ role: z.enum(["admin", "member"]) }).parse(req.body);
    const updated = await prisma.$transaction(async (tx) => {
      await requireAdmin(id, auth.id, tx);
      const member = await tx.groupMember.findUnique({ where: { groupId_userId: { groupId: id, userId: memberId } } });
      if (!member) throw Errors.notFound("Member not found in this group");
      const result = await tx.groupMember.update({
        where: { groupId_userId: { groupId: id, userId: memberId } },
        data: { role: body.role },
        include: { user: true },
      });
      await 