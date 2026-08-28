import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireAdmin, requireMembership } from "../services/access";
import { WEBHOOK_EVENT_TYPES } from "../services/event";
import { createWebhookSecret, dispatchWebhook } from "../services/webhook";

const paramsSchema = z.object({ groupId: z.string().min(1) });
const webhookParamsSchema = paramsSchema.extend({
  webhookId: z.string().min(1),
});
const eventSchema = z.enum(WEBHOOK_EVENT_TYPES);
const createSchema = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    }, "Webhook URL must use HTTP or HTTPS"),
  events: z
    .array(eventSchema)
    .min(1)
    .max(WEBHOOK_EVENT_TYPES.length)
    .refine((events) => new Set(events).size === events.length, {
      message: "events must not contain duplicates",
    }),
});

function publicWebhook(webhook: any, includeSecret = false) {
  return {
    id: webhook.id,
    groupId: webhook.groupId,
    userId: webhook.userId,
    url: webhook.url,
    ...(includeSecret ? { secret: webhook.secret } : {}),
    events: webhook.events,
    enabled: webhook.enabled,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}

/**
 * Registration body for `POST /api/webhooks`.
 *
 * `groupId` is optional: omitted, the endpoint is personal to the caller and
 * receives only their own events. Supplied, it is a group integration — and
 * membership is enforced before the row is written, so a caller cannot
 * subscribe to a group's activity by naming its id.
 */
const registerSchema = createSchema.extend({
  groupId: z.string().min(1).max(64).optional(),
});

export default async function webhookRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- register ---------------------------------------------------------------
  //
  // The secret is generated server-side and returned exactly once, here. It is
  // never included in any subsequent read: a caller who loses it registers a
  // new endpoint rather than recovering the old one, which keeps a leaked
  // response body from being enough to forge signed payloads later.
  app.post("/api/webhooks", async (req, reply) => {
    const auth = requireUser(req);
    const body = registerSchema.parse(req.body);

    if (body.groupId) {
      await requireMembership(body.groupId, auth.id);

      const count = await prisma.webhook.count({
        where: { groupId: body.groupId },
      });
      if (count >= 10) {
        throw Errors.badRequest(
          "webhook_limit_reached",
          "A group can have at most 10 webhooks"
        );
      }
    }

    const webhook = await prisma.webhook.create({
      data: {
        groupId: body.groupId ?? null,
        // A group registration belongs to the group, not to whoever created
        // it, so it keeps working after that member leaves.
        userId: body.groupId ? null : auth.id,
        url: body.url,
        secret: createWebhookSecret(),
        events: body.events,
        enabled: true,
      },
    });

    return reply.code(201).send({ webhook: publicWebhook(webhook, true) });
  });

  app.post("/groups/:groupId/webhooks", async (req) => {
    const auth = requireUser(req);
    const { groupId } = paramsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);
    const body = createSchema.parse(req.body);

    const count = await (prisma as any).webhook.count({ where: { groupId } });
    if (count >= 10) {
      throw Errors.badRequest(
        "webhook_limit_reached",
        "A group can have at most 10 webhooks"
      );
    }

    const webhook = await (prisma as any).webhook.create({
      data: {
        groupId,
        userId: null,
        url: body.url,
        secret: createWebhookSecret(),
        events: body.events,
        enabled: true,
      },
    });

    return { webhook: publicWebhook(webhook, true) };
  });

  app.get("/groups/:groupId/webhooks", async (req) => {
    const auth = requireUser(req);
    const { groupId } = paramsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);

    const webhooks = await (prisma as any).webhook.findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });

    return { webhooks: webhooks.map((webhook: any) => publicWebhook(webhook)) };
  });

  app.delete("/groups/:groupId/webhooks/:webhookId", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);
    await requireAdmin(groupId, auth.id);

    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");

    await (prisma as any).webhook.delete({ where: { id: webhookId } });
    return { deleted: true };
  });

  app.post("/groups/:groupId/webhooks/:webhookId/test", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);

    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId, enabled: true },
      select: { id: true },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");

    void dispatchWebhook(webhookId, "expense.created", {
      test: true,
      message: "This is a test webhook event from Mergepay",
      webhookId,
      requestedBy: auth.id,
      groupId,
    }).catch(() => undefined);

    return { queued: true };
  });

  app.get("/groups/:groupId/webhooks/:webhookId/deliveries", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);

    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId },
      select: { id: true },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");

    const deliveries = await (prisma as any).webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: "desc" },
    });

    return { deliveries };
  });
}
