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

export default async function webhookRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

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
