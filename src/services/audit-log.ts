import { Prisma } from "@prisma/client";
import { prisma } from "../db";

export interface AuditLogFilter {
  action?: string;
  actorUserId?: string;
  from?: Date;
  to?: Date;
}

export interface AuditLogPage {
  events: Prisma.AuditLogGetPayload<{ include: { user: true } }>[];
  nextCursor: string | null;
}

/**
 * List audit events for a group, newest first, using cursor pagination.
 *
 * The caller is responsible for authorizing group administrator access
 * before calling this — this function only scopes and paginates the query.
 */
export async function listAuditLogs(
  groupId: string,
  filter: AuditLogFilter,
  cursor: string | undefined,
  limit: number
): Promise<AuditLogPage> {
  const where: Prisma.AuditLogWhereInput = {
    groupId,
    ...(filter.action && { action: filter.action }),
    ...(filter.actorUserId && { userId: filter.actorUserId }),
    ...((filter.from || filter.to) && {
      createdAt: {
        ...(filter.from && { gte: filter.from }),
        ...(filter.to && { lte: filter.to }),
      },
    }),
  };

  const rows = await prisma.auditLog.findMany({
    where,
    include: { user: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor && { cursor: { id: cursor }, skip: 1 }),
  });

  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;

  return {
    events,
    nextCursor: hasMore ? events[events.length - 1].id : null,
  };
}
