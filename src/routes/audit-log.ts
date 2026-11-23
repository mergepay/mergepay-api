import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Errors } from "../errors";
import { requireGroupRole } from "../plugins/group-access";
import { paginationQuerySchema, requireCursor } from "../lib/pagination";
import { openApiErrorResponses, openApiResponse } from "../lib/openapi";
import { AuditAction } from "../services/audit-actions";
import { queryAuditLogs } from "../services/audit-log";
import { getGroupAuditLogs } from "../services/auditLogService";
import { serializeAuditLogEntry } from "../serializers";

const paramsSchema = z.object({ groupId: z.string().min(1).max(64) });

const filterShape = {
  action: z.nativeEnum(AuditAction).optional(),
  actorUserId: z.string().min(1).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};

const querySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  ...filterShape,
});

const adminQuerySchema = paginationQuerySchema.extend(filterShape);

const auditLogQuerystringSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    action: {
      type: "string",
      description: `One of: ${Object.values(AuditAction).join(", ")}`,
    },
    actorUserId: { type: "string" },
    startDate: { type: "string" },
    endDate: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    cursor: { type: "string" },
    limit: { type: "string" },
    order: { type: "string" },
  },
};

function parseDateRange(query: {
  startDate?: string;
  endDate?: string;
  from?: string;
  to?: string;
}) {
  const from = query.startDate ? new Date(query.startDate) : query.from ? new Date(query.from) : undefined;
  const to = query.endDate ? new Date(query.endDate) : query.to ? new Date(query.to) : undefined;
  if (from && to && from > to) {
    throw Errors.badRequest("invalid_range", "`startDate` must not be after `endDate`");
  }
  return { from, to };
}

export default async function auditLogRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.get(
    "/groups/:groupId/audit-logs",
    { preHandler: requireGroupRole("member", { param: "groupId" }) },
    async (req) => {
      const { groupId } = paramsSchema.parse(req.params);
      const query = querySchema.parse(req.query);
      const { from, to } = parseDateRange(query);
      const { events, nextCursor } = await getGroupAuditLogs(
        groupId,
        { action: query.action, actorUserId: query.actorUserId, from, to },
        query.cursor,
        query.limit
      );
      return { events: events.map(serializeAuditLogEntry), nextCursor };
    }
  );

  // Preserve the original admin-only URL while clients migrate to the
  // membership-authorized plural endpoint.
  app.get(
    "/groups/:groupId/audit-log",
    {
      schema: {
        tags: ["Groups"],
        summary: "List a group's audit log",
        description:
          "Requires a SEP-10 JWT. Group admin only. Returns the group's audit events newest first, with actor, action, timestamp and redacted metadata. Supports action and actor filters, inclusive date bounds, and the shared cursor pagination contract.",
        params: {
          type: "object",
          properties: { groupId: { type: "string" } },
          required: ["groupId"],
        },
        querystring: auditLogQuerystringSchema,
        response: {
          ...openApiResponse(
            {
              events: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
              meta: {
                type: "object",
                additionalProperties: true,
                properties: {
                  nextCursor: { type: ["string", "null"] },
                  hasMore: { type: "boolean" },
                  limit: { type: "integer" },
                  order: { type: "string" },
                },
              },
            },
            ["events", "meta"]
          ),
          ...openApiErrorResponses(400, 401, 403, 404),
        },
      },
      preHandler: requireGroupRole("admin", { param: "groupId" }),
    },
    async (req) => {
      const { groupId } = paramsSchema.parse(req.params);
      const query = adminQuerySchema.parse(req.query ?? {});
      const { from, to } = parseDateRange(query);
      const position = requireCursor(query.cursor);
      const { events, meta } = await queryAuditLogs(
        groupId,
        { action: query.action, actorUserId: query.actorUserId, from, to },
        position,
        query.limit,
        query.order
      );
      return { events: events.map(serializeAuditLogEntry), meta };
    }
  );
}
