import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { stellar } from "../services/stellar";
import { inviteCode } from "../services/codes";
import { auditTx } from "../services/audit";
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
import {
  buildPage,
  encodeCursor,
  decodeCursor,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";

const stellarPublicKeySchema = z.string().regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar public key format");

const GROUP_BALANCE_CACHE_TTL_MS = 30_000;
const groupBalanceCache = new Map<string, { expiresAt: number; balances: { asset: "XLM" | "USDC"; balance: string }[] }>();

export function clearGroupBalanceCache(): void {
  groupBalanceCache.clear();
}

export default async function groupRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- create -----------------------------------------------------------------
  app.post("/groups", { config: { rateLimit: { max: config.RATE_LIMIT_GROUP, timeWindow: "1 minute" } } }, async (req) => {
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
      await auditTx(tx, {
        userId: auth.id,
        action: "group.create",
        entityType: "group",
        entityId: created.id,
        metadata: { name: body.name },
      });
      return created;
    });
    return { group: serializeGroup(group) };
  });

  // -- list (with summaries) -------------------------------------------------
  //
  // Paginated because each row costs a balance computation, so an unbounded
  // list would scale that work with a user's group count. Membership rows are
  // ordered by `joinedAt`, which is this resource's creation timestamp, so the
  // shared cursor helpers are given that field as `createdAt`.
  app.get("/groups", async (req) => {
    const auth = requireUser(req);
    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    const position = requireCursor(cursor);

    const cursorScope = position
      ? {
          OR: [
            { joinedAt: { [order === "desc" ? "lt" : "gt"]: position.createdAt } },
            {
              joinedAt: position.createdAt,
              id: { [order === "desc" ? "lt" : "gt"]: position.id },
            },
          ],
        }
      : {};

    const memberships = await prisma.groupMember.findMany({
      where: { userId: auth.id, ...cursorScope },
      include: { group: { include: { _count: { select: { members: true } } } } },
      orderBy: [{ joinedAt: order }, { id: order }],
      take: takeForPage(limit),
    });

    const { items, meta } = buildPage(
      memberships.map((m) => ({ ...m, createdAt: m.joinedAt })),
      limit,
      order
    );

    const groups = await Promise.all(
      items.map(async (m) => {
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

    return { groups, meta };
  });

  // -- on-chain balance -------------------------------------------------------
  app.get("/groups/:id/balance", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    await requireMembership(id, auth.id);

    const cached = groupBalanceCache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return { balances: cached.balances };
    }
    if (cached) groupBalanceCache.delete(id);

    const group = await prisma.group.findUnique({
      where: { id },
      select: { treasuryAccountPublicKey: true },
    });
    if (!group?.treasuryAccountPublicKey) {
      const balances: { asset: "XLM" | "USDC"; balance: string }[] = [];
      groupBalanceCache.set(id, { expiresAt: Date.now() + GROUP_BALANCE_CACHE_TTL_MS, balances });
      return { balances };
    }

    const account = await stellar.loadAccount(group.treasuryAccountPublicKey);
    if (!account.exists) {
      const balances: { asset: "XLM" | "USDC"; balance: string }[] = [];
      groupBalanceCache.set(id, { expiresAt: Date.now() + GROUP_BALANCE_CACHE_TTL_MS, balances });
      return { balances };
    }

    const balances = account.balances
      .filter((balance) =>
        balance.assetCode === "XLM" ||
        (balance.assetCode === "USDC" && balance.assetIssuer === config.STABLE_ASSET_ISSUER)
      )
      .map((balance) => ({ asset: balance.assetCode as "XLM" | "USDC", balance: balance.balance }));

    groupBalanceCache.set(id, {
      expiresAt: Date.now() + GROUP_BALANCE_CACHE_TTL_MS,
      balances,
    });
    return { balances };
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
        await auditTx(tx, {
          userId: auth.id,
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
  app.post("/groups/:id/leave", async (req) => {
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

    // The lookup, the last-admin guard, the delete, and the audit record run
    // in one transaction. Previously they did not: two concurrent removals
    // could each see two admins and both proceed, leaving the group with
    // none, and the audit write happened after the commit where a failure
    // would lose the record of a removal that had already happened.
    await prisma.$transaction(async (tx) => {
      const target = await tx.groupMember.findUnique({
        where: { groupId_userId: { groupId: id, userId: memberId } },
      });
      if (!target) {
        throw Errors.notFound("Member not found in this group");
      }

      if (target.role === "admin") {
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
        action: "group.member_remove",
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
  app.post("/groups/:id/members/role", async (req) => {
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
  app.post("/groups/:id/archive", async (req) => {
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
