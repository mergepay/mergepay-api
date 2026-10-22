/**
 * Paginated reads of a group's webhook endpoints and their delivery attempts
 * (issue #692).
 *
 * ## Why these two lists needed their own module
 *
 * Both routes used to answer with an unbounded `findMany`. For the endpoint
 * list that is merely untidy — a group has a handful of endpoints. For
 * deliveries it is a real liability: one row is written per event per
 * endpoint, with a row kept for every retry, so an active group accumulates
 * them without limit. `GET /groups/:groupId/webhooks/:webhookId/deliveries`
 * therefore grew without bound in three places at once — the database scan,
 * the JSON serialization, and the response body — and the first request a
 * busy group made after a quiet week was the one that noticed.
 *
 * Paging both of them is the fix. The query construction lives here rather
 * than in the route so the filter semantics can be tested without an HTTP
 * server, which is the same split `src/services/expenses.ts` uses for the
 * group expense list.
 *
 * ## Contract
 *
 * `src/lib/pagination.ts`, unchanged: a `(createdAt, id)` cursor, `limit + 1`
 * rows fetched to decide `hasMore` without a second count query, and the one
 * `meta` shape every list endpoint in this API returns. Filters compose with
 * the cursor rather than replacing it, so a filtered scan pages exactly like
 * an unfiltered one.
 *
 * ## What a delivery row may disclose
 *
 * A delivery carries the exact bytes that were signed and sent (`payload`) and
 * whatever the receiver answered (`responseBody`). Neither belongs in a list
 * response: the payload is the group's own data re-served through a different
 * authorization path, and the response body is text from a third-party server
 * echoed back to a group member. `deliverySummary` is the allowlist of fields
 * a list may return, so adding a column to the model does not silently widen
 * what this endpoint exposes.
 */
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../db";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
  type PageMeta,
} from "../lib/pagination";
import { WEBHOOK_EVENT_TYPES } from "./event";

/** Delivery states the worker records, as clients may filter by them. */
export const DELIVERY_STATUSES = ["pending", "delivered", "failed"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/**
 * Query parameters for the delivery list.
 *
 * Extends the shared pagination schema, so cursor/limit/order behave exactly
 * as they do on every other paginated route; the two filters are additive.
 * `status` answers the question the endpoint exists for — "what is failing to
 * reach my endpoint" — without making the caller page through the successes.
 */
export const deliveryListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(DELIVERY_STATUSES).optional(),
  event: z.enum(WEBHOOK_EVENT_TYPES).optional(),
});

export type DeliveryListQuery = z.infer<typeof deliveryListQuerySchema>;

/** Query parameters for the endpoint list: pagination only, no filters. */
export const webhookListQuerySchema = paginationQuerySchema;

export interface ListPage<T> {
  items: T[];
  meta: PageMeta;
}

/**
 * The fields a delivery list returns. Deliberately an allowlist — see the
 * module comment on `payload` and `responseBody`.
 */
export interface DeliverySummary {
  id: string;
  webhookId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatusCode: number | null;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function deliverySummary(row: {
  id: string;
  webhookId: string;
  eventType: string;
  status: string;
  attempts: number;
  responseStatusCode: number | null;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DeliverySummary {
  return {
    id: row.id,
    webhookId: row.webhookId,
    eventType: row.eventType,
    status: row.status,
    attempts: row.attempts,
    responseStatusCode: row.responseStatusCode ?? null,
    nextAttemptAt: row.nextAttemptAt ? row.nextAttemptAt.toISOString() : null,
    lastAttemptAt: row.lastAttemptAt ? row.lastAttemptAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The filter conditions for a delivery query, excluding pagination.
 *
 * Exported so the semantics can be asserted against the shape handed to
 * Prisma, without standing up a route.
 */
export function deliveryFilters(
  webhookId: string,
  query: Pick<DeliveryListQuery, "status" | "event">
): Prisma.WebhookDeliveryWhereInput[] {
  return [
    { webhookId },
    ...(query.status ? [{ status: query.status }] : []),
    ...(query.event ? [{ eventType: query.event }] : []),
  ];
}

/**
 * List one page of a webhook's delivery attempts.
 *
 * The caller must have authorized access to the endpoint's group first: this
 * function scopes by `webhookId` and performs no membership check of its own.
 */
export async function listWebhookDeliveries(
  webhookId: string,
  query: DeliveryListQuery
): Promise<ListPage<DeliverySummary>> {
  const position = requireCursor(query.cursor);
  const filters = deliveryFilters(webhookId, query);
  const cursorCondition = cursorFilter(position, query.order);

  // With no filters beyond the endpoint scope the query keeps its flat shape;
  // only a filtered request pays for the `AND` wrapper. Either way the cursor
  // condition stays separate from the filters, so paging never widens the
  // result set.
  const where: Prisma.WebhookDeliveryWhereInput =
    filters.length === 1
      ? { webhookId, ...cursorCondition }
      : { AND: [...filters, cursorCondition] };

  const rows = await prisma.webhookDelivery.findMany({
    where,
    orderBy: cursorOrderBy(query.order),
    take: takeForPage(query.limit),
  });

  const { items, meta } = buildPage(rows, query.limit, query.order);
  return { items: items.map(deliverySummary), meta };
}

/**
 * List one page of a group's webhook endpoints.
 *
 * As above, group access is the caller's responsibility; `groupId` is what
 * scopes the page, never the cursor.
 */
export async function listGroupWebhooks(
  groupId: string,
  query: z.infer<typeof webhookListQuerySchema>
): Promise<ListPage<{ id: string; createdAt: Date }>> {
  const position = requireCursor(query.cursor);

  const rows = await prisma.webhook.findMany({
    where: { groupId, ...cursorFilter(position, query.order) },
    orderBy: cursorOrderBy(query.order),
    take: takeForPage(query.limit),
  });

  return buildPage(rows, query.limit, query.order);
}
