import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { serializeGroup } from "../serializers";

export default async function userGroupsRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get("/users/:id/groups", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);

    // Only the authenticated user can access their own groups
    if (auth.id !== id) {
      throw Errors.forbidden();
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id },
    });
    if (!user) {
      throw Errors.notFound("User not found");
    }

    // Parse pagination parameters
    const query = z
      .object({
        page: z
          .string()
          .optional()
          .transform((v) => (v ? parseInt(v, 10) : 1))
          .refine((v) => !isNaN(v) && v > 0, { message: "Page must be a positive integer" }),
        limit: z
          .string()
          .optional()
          .transform((v) => (v ? parseInt(v, 10) : 10))
          .refine((v) => !isNaN(v) && v > 0 && v <= 100, { message: "Limit must be between 1 and 100" }),
      })
      .parse(req.query);

    const offset = (query.page - 1) * query.limit;

    // Retrieve user's group memberships with member counts
    const memberships = await prisma.groupMember.findMany({
      where: { userId: id },
      include: {
        group: {
          include: {
            _count: {
              select: { members: true },
            },
          },
        },
      },
      orderBy: { joinedAt: "desc" },
      skip: offset,
      take: query.limit,
    });

    const groups = memberships.map((m) => {
      const g = m.group;
      return {
        id: g.id,
        name: g.name,
        description: g.description ?? null,
        memberCount: (g as any)._count.members,
        createdAt: g.createdAt.toISOString(),
      };
    });

    return { groups };
  });
}
