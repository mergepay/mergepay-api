import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { inviteCode } from "../services/codes";
import { audit, AuditAction } from "../services/audit";
import { stellarPublicKeySchema } from "../lib/stellar-validation";
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

export default async function groupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- create -----------------------------------------------------------------
  app.post("/groups", async (req) => {
    const auth = requireUser(req);
    const body = z
      .object({
        name: z.string().min(1).max(60),
        description: z.string().max(280).optional(),
      })
      .parse(req.body);

    const group = await prisma.$transaction(async (tx) => {
      const created = await tx.group.create({
        data: {
          name: body.name,
          description: body.description,
          createdByUserId: auth.id,
          members: { create: { userId: auth.id, role: "admin" } },
        },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.GroupCreate,
          entityType: "group",
          entityId: created.id,
        },
        tx
      );
      return created;
    });
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
    const ctx = await requireMembership(id, auth.id);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group) throw Errors.notFound("Group not found");
    const members = await prisma.groupMember.findMany({
      where: { groupId: id },
      include: { user: true },
      orderBy: { joinedAt: "asc" },
    });

    return {
      group: serializeGroup(group),
      members: members.map(serializeMember),
      yourRole: ctx.role,
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
          publicKey: stellarPublicKeySchema,
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

      const invitation = await prisma.$transaction(async (tx) => {
        const created = await tx.invitation.create({
          data: {
            groupId: id,
            inviteePublicKey: body.publicKey,
            status: "PENDING",
          },
        });
        await audit(
          {
            actor: { type: "user", userId: auth.id },
            action: AuditAction.GroupInviteDirect,
            entityType: "invitation",
            entityId: created.id,
            metadata: { groupId: id, inviteePublicKey: body.publicKey },
          },
          tx
        );
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
      const created = await tx.invite.create({
        data: {
          groupId: id,
          code: inviteCode(),
          createdByUserId: auth.id,
          maxUses: body.maxUses ?? null,
          expiresAt,
        },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.GroupInviteCodeCreate,
          entityType: "invite",
          entityId: created.id,
          metadata: { groupId: id, maxUses: body.maxUses ?? null, expiresAt },
        },
        tx
      );
      return created;
    });
    return { invite: serializeInvite(invite, config.WEB_URL) };
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
      await prisma.$transaction(async (tx) => {
        await tx.groupMember.create({
          data: { groupId: invite.groupId, userId: auth.id, role: "member" },
        });
        await tx.invite.update({
          where: { id: invite.id },
          data: { uses: { increment: 1 } },
        });
        await audit(
          {
            actor: { type: "user", userId: auth.id },
            action: AuditAction.GroupJoin,
            entityType: "group",
            entityId: invite.groupId,
            metadata: { inviteId: invite.id },
          },
          tx
        );
      });
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

    await prisma.$transaction(async (tx) => {
      await tx.groupMember.delete({
        where: { groupId_userId: { groupId: id, userId: auth.id } },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.GroupLeave,
          entityType: "group",
          entityId: id,
        },
        tx
      );
    });
    return { ok: true };
  });

  // -- archive ----------------------------------------------------------------
  app.post("/groups/:id/archive", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    const group = await prisma.$transaction(async (tx) => {
      const updated = await tx.group.update({
        where: { id },
        data: { archived: true },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.GroupArchive,
          entityType: "group",
          entityId: id,
        },
        tx
      );
      return updated;
    });
    return { group: serializeGroup(group) };
  });
}
