import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../errors";
import { requireGroupRole } from "../plugins/group-access";
import { listAuditLogs } from "../services/audit-log";
import { getGroupAuditLogs } from "../services/auditLogService";
import { serializeAuditLogEntry } from "../serializers";

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().min(1).max(100).optional(),
  actorUserId: z.string().min(1).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export default async function auditLogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  const handler = async (req: any, legacy = false) => {
    const { groupId } = z.object({ groupId: z.string().min(1).max(64) }).parse(req.params);

    const query = querySchema.parse(req.query);
    const from = query.startDate ? new Date(query.startDate) : query.from ? new Date(query.from) : undefined;
    const to = query.endDate ? new Date(query.endDate) : query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw Errors.badRequest("invalid_range", "`startDate` must not be after `endDate`");
    }

    const { events, nextCursor } = await (legacy ? listAuditLogs : getGroupAuditLogs)(
      groupId,
      { action: query.action, actorUserId: query.actorUserId, from, to },
      query.cursor,
      query.limit
    );

    return {
      events: events.map(serializeAuditLogEntry),
      nextCursor,
    };
  };

  app.get(
    "/groups/:groupId/audit-logs",
    { preHandler: requireGroupRole("member", { param: "groupId" }) },
    (req) => handler(req)
  );
  // Preserve the original admin-only URL while clients migrate to the
  // membership-authorized plural endpoint.
  app.get(
    "/groups/:groupId/audit-log",
    { preHandler: requireGroupRole("admin", { param: "groupId" }) },
    (req) => handler(req, true)
  );
}
