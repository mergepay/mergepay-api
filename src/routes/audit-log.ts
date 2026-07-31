import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireAdmin } from "../services/access";
import { listAuditLogs } from "../services/audit-log";
import { serializeAuditLogEntry } from "../serializers";

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().min(1).max(100).optional(),
  actorUserId: z.string().min(1).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

export default async function auditLogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // Group administrators only — audit history is a privileged view into
  // membership, expense, treasury, and settlement changes for the group.
  app.get("/groups/:id/audit-log", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);

    const query = querySchema.parse(req.query);
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;
    if (from && to && from > to) {
      throw Errors.badRequest("invalid_range", "`from` must not be after `to`");
    }

    const { events, nextCursor } = await listAuditLogs(
      id,
      { action: query.action, actorUserId: query.actorUserId, from, to },
      query.cursor,
      query.limit
    );

    return {
      events: events.map(serializeAuditLogEntry),
      nextCursor,
    };
  });
}
