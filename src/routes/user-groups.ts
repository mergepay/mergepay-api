import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { serializeGroup } from "../serializers";
import {
  MAX_PAGE_SIZE,
  buildPage,
  requireCursor,
  takeForPage,
  type SortOrder,
} from "../lib/pagination";

/**
 * This route predates the shared pagination contract and shipped with offset
 * paging, so it validates its own query rather than reusing
 * `paginationQuerySchema` directly: `page` has to stay accepted, and the
 * original default page size of 10 has to stay 10 — adopting the shared
 * default of 50 would quietly change what existing clients receive.
 *
 * `limit` keeps its original bound. `cursor` and `order` are the shared
 * contract's, so a client that moves to keyset paging here uses exactly the
 * parameters it uses on every other list endpoint.
 */
const querySchema = z.object({
  cursor: z.string().min(1).max(512).optional(),
  page: z.coerce
    .number()
    .int()
    .positive("Page must be a positive integer")
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1, "Limit must be between 1 and 100")
    .max(MAX_PAGE_SIZE, "Limit must be between 1 and 100")
    .default(10),
  order: z.enum(["asc", "desc"]).default("desc"),
});

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

    const query = querySchema.parse(req.query ?? {});

    // Keyset is the preferred path; `page` remains accepted so clients written
    // against the original offset contract keep working. Offset pagination
    // drifts — a membership added while a user pages causes a row to repeat or
    // be skipped — so a caller sending both gets the cursor, which does not.
    const position = requireCursor(query.cursor);
    const usingCursor = position !== null || query.page === undefined;
    const order: SortOrder = query.order;

    // Membership rows order by `joinedAt`, this resource's creation timestamp,
    // so the shared helpers are given that field as `createdAt` — the same
    // treatment GET /groups uses for the identical shape.
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
      where: { userId: id, ...cursorScope },
      include: {
        group: {
          include: {
            _count: {
              select: { members: true },
            },
          },
        },
      },
      // `(joinedAt, id)` rather than `joinedAt` alone: timestamps tie when a
      // user is added to several groups in one transaction, and a tie under a
      // single-key sort has no defined resolution, so a row could appear on two
      // pages or neither.
      orderBy: [{ joinedAt: order }, { id: order }],
      ...(usingCursor
        ? { take: takeForPage(query.limit) }
        : { skip: (query.page! - 1) * query.limit, take: query.limit }),
    });

    const serialize = (m: (typeof memberships)[number]) => {
      const g = m.group;
      return {
        id: g.id,
        name: g.name,
        description: g.description ?? null,
        memberCount: (g as any)._count.members,
        createdAt: g.createdAt.toISOString(),
      };
    };

    // The offset path returns exactly what it always did, with no `meta` — its
    // clients never had one and adding a next cursor to an offset page would
    // describe a boundary the next `page=` request does not honour.
    if (!usingCursor) {
      return { groups: memberships.map(serialize) };
    }

    const { items, meta } = buildPage(
      memberships.map((m) => ({ ...m, createdAt: m.joinedAt })),
      query.limit,
      order
    );

    return { groups: items.map(serialize), meta };
  });
}
