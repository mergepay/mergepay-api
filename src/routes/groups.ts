import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { inviteCode } from "../services/codes";
import { audit } from "../services/audit";
import { auditLog } from "../lib/auditLog";
import {
  serializeGroup,
  serializeInvitation,
  serializeInvite,
  serializeMember,
} from "../serializers";
import {
  groupPrimaryAsset,
  loadGroupBalances,
} from "../services/group-balances";
import { paginationQuerySchema, encodeCursor, decodeCursor } from "../lib/pagination";

export default async function groupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- create -----------------------------------------------------------------
  app.post("/groups", { config: { rateLimit: { max: config.AUTH_RATE_LIMIT_MAX, timeWindow: "1 minute" } } }, async (req) => {
    const auth = requireUser(req);
    const body = z
      .object({
        name: z.string().min(1).max(60),
        description: z.string().max(280).optional(),
      })
      .parse(req.body);

    const group = await prisma.group.create({
      data: {
        name: body.name,
        description: body.description,
        createdByUserId: auth.id,
        members: { create: { userId: auth.id, role: "admin" } },
      },
    });
    await audit({
      userId: auth.id,
      action: "group.create",
      entityType: "group",
      entityId: group.id,
    });
    await auditLog.log("GROUP_CREATED", auth.id, group.id, { name: body.name });
    return { group: serializeGroup(group) };
  });

  // -- list (with summaries) -------------------------------------------------
  app.get("/groups", async (req) => {
    const auth = requireUser(req);
    const memberships = await prisma.groupMember.findMany({
      where: { userId: auth.id },
      include: { group: { include: { _count: { select: { members: true } } } } },
      orderBy: { joinedAt: "desc" },
    });

    const groups = await Promise.all(
      memberships.map(async (m) => {
        const balances = await loadGroupBalances(m.groupId);
        const asset = await groupPrimaryAsset(m.groupId);
        const yourNet =
          balances.find((b) => b.userId === auth.id)?.net ?? "0";
        return {
          ...serializeGroup(m.group),
          memberCount: (m.group as any)._count.members,
          yourNet,
          netAssetCode: asset.assetCode,
        };
      })
    );

    return { groups };
  });

  // -- detail -----------------------------------------------------------------
  app.get("/groups/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { cursor, limit } = paginationQuerySchema.parse(req.query ?? {});
    const ctx = await requireMembership(id, auth.id);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw Errors.notFound("Group not found");

    let decodedCursor = null;
    if (cursor) {
      decodedCursor = decodeCursor(cursor);
      if (!decodedCursor) {
        throw Errors.badRequest("invalid_cursor", "The provided cursor is invalid");
      }
    }

    const members = await prisma.groupMember.findMany({
      where: {
        groupId: id,
        ...(decodedCursor && {
          OR: [
            { joinedAt: { gt: decodedCursor.createdAt } },
            {
              joinedAt: decodedCursor.createdAt,
              id: { gt: decodedCursor.id },
            },
          ],
        }),
      },
      include: { user: true },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      take: limit + 1,
    });

    const hasMore = members.length > limit;
    const results = hasMore ? members.slice(0, limit) : members;
    const nextCursor = hasMore
      ? encodeCursor(
          results[results.length - 1].joinedAt,
          results[results.length - 1].id
        )
      : null;

    return {
      group: serializeGroup(group),
      members: results.map(serializeMember),
      yourRole: ctx.role,
      meta: { nextCursor, hasMore },
    };
  });

  // -- invite (by public key or invite code) ---------------------------------
  app.post("/groups/:id/invite", async (req, reply) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);

    // Direct invitation by Stellar public key
    if (
      typeof req.body === "object" &&
      req.body &&
      "publicKey" in req.body
    ) {
      const body = z
        .object({
          publicKey: z.string().regex(/^G[A-Z0-9]{55}$/),
        })
        .parse(req.body);

      // Check if invitee is already a member
      const inviteeUser = await prisma.user.findUnique({
        where: { stellarPublicKey: body.publicKey },
      });
      if (inviteeUser) {
        const existingMember = await prisma.groupMember.findUnique({
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
      const existingInvitation = await prisma.invitation.findFirst({
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

      const invitation = await prisma.invitation.create({
        data: {
          groupId: id,
          inviteePublicKey: body.publicKey,
          status: "PENDING",
        },
      });

      await audit({
        userId: auth.id,
        action: "group.invite",
        entityType: "invitation",
        entityId: invitation.id,
        metadata: { groupId: id, inviteePublicKey: body.publicKey },
      });
      await auditLog.log("MEMBER_INVITED", auth.id, id, {
        inviteePublicKey: body.publicKey,
        invitationId: invitation.id,
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

    const invite = await prisma.invite.create({
      data: {
        groupId: id,
        code: inviteCode(),
        createdByUserId: auth.id,
        maxUses: body.maxUses ?? null,
        expiresAt,
      },
    });
    await auditLog.log("INVITE_CREATED", auth.id, id, {
      inviteId: invite.id,
      code: invite.code,
    });
    return { invite: serializeInvite(invite, config.WEB_URL) };
  });

  // -- remove member --------------------------------------------------------
  app.delete("/groups/:id/members/:memberId", async (req) => {
    const auth = requireUser(req);
    const { id, memberId } = z
      .object({ id: z.string(), memberId: z.string() })
      .parse(req.params);
    await requireAdmin(id, auth.id);

    const member = await prisma.groupMember.findFirst({
      where: {
        groupId: id,
        OR: [{ id: memberId }, { userId: memberId }],
      },
    });
    if (!member) throw Errors.notFound("Member not found");

    if (member.userId === auth.id) {
      throw Errors.badRequest("cannot_remove_self", "Use leave endpoint to leave the group");
    }

    await prisma.groupMember.delete({
      where: { id: member.id },
    });
    await auditLog.log("MEMBER_REMOVED", auth.id, id, {
      memberId: member.id,
      userId: member.userId,
    });
    return { ok: true };
  });

  // -- join -------------------------------------------------------------------
  app.post("/groups/join", async (req) => {
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

    const existing = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: invite.groupId, userId: auth.id } },
    });

    if (!existing) {
      await prisma.$transaction([
        prisma.groupMember.create({
          data: { groupId: invite.groupId, userId: auth.id, role: "member" },
        }),
        prisma.invite.update({
          where: { id: invite.id },
          data: { uses: { increment: 1 } },
        }),
      ]);
      await audit({
        userId: auth.id,
        action: "group.join",
        entityType: "group",
        entityId: invite.groupId,
      });
      await auditLog.log("MEMBER_JOINED", auth.id, invite.groupId);
    }

    const group = await prisma.group.findUnique({
      where: { id: invite.groupId },
    });
    return { group: serializeGroup(group) };
  });

  // -- leave ------------------------------------------------------------------
  app.post("/groups/:id/leave", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const ctx = await requireMembership(id, auth.id);

    if (ctx.role === "admin") {
      const [adminCount, totalCount] = await Promise.all([
        prisma.groupMember.count({ where: { groupId: id, role: "admin" } }),
        prisma.groupMember.count({ where: { groupId: id } }),
      ]);
      if (adminCount === 1 && totalCount > 1) {
        throw Errors.conflict(
          "last_admin",
          "Promote another member to admin before leaving"
        );
      }
    }

    await prisma.groupMember.delete({
      where: { groupId_userId: { groupId: id, userId: auth.id } },
    });
    await audit({
      userId: auth.id,
      action: "group.leave",
      entityType: "group",
      entityId: id,
    });
    await auditLog.log("MEMBER_LEFT", auth.id, id);
    return { ok: true };
  });

  // -- remove member ---------------------------------------------------------
  app.delete("/groups/:id/members/:memberId", async (req) => {
    const auth = requireUser(req);
    const { id, memberId } = z
      .object({ id: z.string(), memberId: z.string() })
      .parse(req.params);
    await requireAdmin(id, auth.id);

    if (memberId === auth.id) {
      throw Errors.badRequest(
        "SELF_REMOVE",
        "Cannot remove yourself from the group; use the leave endpoint instead"
      );
    }

    const target = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId: id, userId: memberId } },
    });
    if (!target) {
      throw Errors.notFound("Member not found in this group");
    }

    if (target.role === "admin") {
      const adminCount = await prisma.groupMember.count({
        where: { groupId: id, role: "admin" },
      });
      if (adminCount <= 1) {
        throw Errors.conflict(
          "last_admin",
          "Cannot remove the last admin from the group"
        );
      }
    }

    await prisma.groupMember.delete({
      where: { groupId_userId: { groupId: id, userId: memberId } },
    });
    await audit({
      userId: auth.id,
      action: "group.member_remove",
      entityType: "group",
      entityId: id,
      metadata: { removedUserId: memberId },
    });
    return { ok: true };
  });

  // -- archive ----------------------------------------------------------------
  app.post("/groups/:id/archive", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    const group = await prisma.group.update({
      where: { id },
      data: { archived: true },
    });
    await audit({
      userId: auth.id,
      action: "group.archive",
      entityType: "group",
      entityId: id,
    });
    await auditLog.log("GROUP_ARCHIVED", auth.id, id);
    return { group: serializeGroup(group) };
  });
}
