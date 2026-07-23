import { randomBytes } from "node:crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireAdmin, requireMembership } from "../services/access";
import { deliverWebhook, EVENT_TYPES } from "../services/webhook";

const createWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.enum(EVENT_TYPES)).min(1),
});

export default async function webhookRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/groups/:groupId/webhooks", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);
    const body = createWebhookSchema.parse(req.body);

    const count = await (prisma as any).webhook.count({ where: { groupId } });
    if (count >= 10) {
      throw Errors.badRequest("webhook_limit", "A group may have at most 10 webhooks");
    }

    const webhook = await (prisma as any).webhook.create({
      data: {
        groupId,
        userId: null,
        url: body.url,
        secret: randomBytes(32).toString("hex"),
        events: body.events,
        enabled: true,
      },
    });

    return {
      webhook: {
        id: webhook.id,
        groupId: webhook.groupId,
        url: webhook.url,
        events: webhook.events,
        enabled: webhook.enabled,
        secret: webhook.secret,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
      },
    };
  });

  app.get("/groups/:groupId/webhooks", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);
    const webhooks = await (prisma as any).webhook.findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });

    return {
      webhooks: webhooks.map((webhook: any) => ({
        id: webhook.id,
        groupId: webhook.groupId,
        url: webhook.url,
        events: webhook.events,
        enabled: webhook.enabled,
        createdAt: webhook.createdAt,
        updatedAt: webhook.updatedAt,
      })),
    };
  });

  app.delete("/groups/:groupId/webhooks/:webhookId", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = z
      .object({ groupId: z.string(), webhookId: z.string() })
      .parse(req.params);
    await requireAdmin(groupId, auth.id);
    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");
    await (prisma as any).webhook.delete({ where: { id: webhookId } });
    return { ok: true };
  });

  app.post("/groups/:groupId/webhooks/:webhookId/test", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = z
      .object({ groupId: z.string(), webhookId: z.string() })
      .parse(req.params);
    await requireMembership(groupId, auth.id);
    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId, enabled: true },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");

    const payload = JSON.stringify({
      eventType: "expense.created",
      data: { test: true, message: "Mergepay webhook test" },
      timestamp: new Date().toISOString(),
    });
    await deliverWebhook(webhook, "expense.created", payload);
    return { ok: true };
  });

  app.get("/groups/:groupId/webhooks/:webhookId/deliveries", async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = z
      .object({ groupId: z.string(), webhookId: z.string() })
      .parse(req.params);
    await requireMembership(groupId, auth.id);
    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");
    const deliveries = await (prisma as any).webhookDelivery.findMany({
      where: { webhookId },
      orderBy: { createdAt: "desc" },
    });
    return { deliveries };
  });
}
