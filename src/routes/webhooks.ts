import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireAdmin, requireMembership } from "../services/access";
import { WEBHOOK_EVENT_TYPES } from "../services/event";
import { deliverWebhook } from "../services/webhook";

const paramsSchema = z.object({ groupId: z.string() });
const webhookParamsSchema = paramsSchema.extend({ webhookId: z.string() });
const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(WEBHOOK_EVENT_TYPES.length),
});

function publicWebhook(webhook: {
  id: string;
  groupId: string | null;
  userId: string | null;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: webhook.id,
    groupId: webhook.groupId,
    userId: webhook.userId,
    url: webhook.url,
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
    const body = createWebhookSchema.parse(req.body);

    const count = await prisma.webhook.count({ where: { groupId } });
    if (count >= 10) {
      throw Errors.badRequest("webhook_limit", "A group can have at most 10 webhooks");
    }

    const webhook = await prisma.webhook.create({
      data: {
        groupId,
        userId: auth.id,
        url: body.url,
        secret: crypto.randomBytes(32).toString("hex"),
        events: [...new Set(body.events)],
        enabled: true,
      },
    });

    return { webhook: publicWebhook(webhook), secret: webhook.secret };
  });

  app.get("/groups/:groupId/webhooks", async (req) => {
    const auth = requireUser(req);
    const { groupId } = paramsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);
    const webhooks = await prisma.webhook.findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });
    return { webhooks: webhooks.map(publicWebhook) };
  });

  app.delete("/groups/:groupId/webhooks/:webhookId", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);
    await requireAdmin(groupId, auth.id);
    const webhook = await prisma.webhook.findFirst({ where: { id: webhookId, groupId } });
    if (!webhook) throw Errors.notFound("Webhook not found");
    await prisma.webhook.delete({ where: { id: webhookId } });
    return { deleted: true };
  });

  app.post("/groups/:groupId/webhooks/:webhookId/test", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);
    const webhook = await prisma.webhook.findFirst({ where: { id: webhookId, groupId } });
    if (!webhook) throw Errors.notFound("Webhook not found");

    void deliverWebhook(webhook, {
      eventType: "expense.created",
      groupId,
      userId: auth.id,
      payload: { test: true, message: "This is a Mergepay webhook test event" },
    }).catch(() => undefined);

    return { queued: true };
  });

  app.get("/groups/:groupId/webhooks/:webhookId/deliveries", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);
    const webhook = await prisma.webhook.findFirst({ where: { id: webhookId, groupId } });
    if (!webhook) throw Errors.notFound("Webhook not found");
    const deliveries = await prisma.webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: "desc" },
    });
    return { deliveries };
  });
}
