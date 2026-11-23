import { Prisma } from "@prisma/client";
import { prisma } from "../db";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  takeForPage,
  type CursorPosition,
  type PageMeta,
  type SortOrder,
} from "../lib/pagination";

export interface AuditLogFilter {
  action?: string;
  actorUserId?: string;
  entityType?: string;
  entityId?: string;
  correlationId?: string;
  from?: Date;
  to?: Date;
}

export interface AuditLogPage {
  events: Prisma.AuditLogGetPayload<{ include: { user: true } }>[];
  nextCursor: string | null;
}

export interface AuditLogPageResult {
  events: Prisma.AuditLogGetPayload<{ include: { user: true } }>[];
  meta: PageMeta;
}

function auditLogWhere(groupId: string, filter: AuditLogFilter): Prisma.AuditLogWhereInput {
  return {
    groupId,
    ...(filter.action && { action: filter.action }),
    ...(filter.actorUserId && { userId: filter.actorUserId }),
    ...(filter.entityType && { entityType: filter.entityType }),
    ...(filter.entityId && { entityId: filter.entityId }),
    ...(filter.correlationId && { correlationId: filter.correlationId }),
    ...((filter.from || filter.to) && {
      createdAt: {
        ...(filter.from && { gte: filter.from }),
        ...(filter.to && { lte: filter.to }),
      },
    }),
  };
}

export async function queryAuditLogs(
  groupId: string,
  filter: AuditLogFilter,
  position: CursorPosition | null,
  limit: number,
  order: SortOrder = "desc"
): Promise<AuditLogPageResult> {
  const rows = await prisma.auditLog.findMany({
    where: { ...auditLogWhere(groupId, filter), ...cursorFilter(position, order) },
    include: { user: true },
    orderBy: cursorOrderBy(order),
    take: takeForPage(limit),
  });

  const { items, meta } = buildPage(rows, limit, order);
  return { events: items, meta };
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
  const rows = await prisma.auditLog.findMany({
    where: auditLogWhere(groupId, filter),
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
