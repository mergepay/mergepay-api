import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { requireGroupRole } from "../plugins/group-access";
import { WEBHOOK_EVENT_TYPES } from "../services/event";
import { rateLimited } from "../lib/rate-limit";
import {
  applySep24Callback,
  sep24CallbackSchema,
  verifySep24Signature,
} from "../services/sep24";
import { createWebhookSecret, dispatchWebhook } from "../services/webhook";
import { audit } from "../services/audit";

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
 * Inbound SEP-24 anchor callbacks.
 *
 * Registered in its own encapsulated scope for two reasons that both matter:
 *
 *  - **No authenticate hook.** The management routes below run behind
 *    `app.authenticate`; an anchor has no Mergepay session and never will. Its
 *    only credential is the HMAC signature over the body, so this route must
 *    not inherit that hook.
 *  - **Raw body.** The signature covers the exact bytes the anchor sent. A
 *    scoped content type parser keeps the buffer intact and parses JSON only
 *    after the signature has been verified — re-serializing a parsed object
 *    would produce different bytes and fail every legitimate signature.
 */
async function sep24CallbackRoute(app: FastifyInstance) {
  // Scoped to this plugin only: the rest of the API keeps Fastify's default
  // JSON parsing. `parseAs: "buffer"` hands the handler untouched bytes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    }
  );

  app.post(
    "/api/webhooks/sep24",
    {
      ...rateLimited("sep24Webhook"),
      schema: {
        tags: ["SEP-24"],
        summary: "Process SEP-24 anchor webhook (HMAC-signed)",
        description:
          "Accepts SEP-24 transaction status callbacks authenticated with a pre-shared HMAC-SHA256 secret.",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              received: { type: "boolean" },
              status: { type: "string" },
              matched: { type: "integer" },
              updated: { type: "integer" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const rawBody = Buffer.isBuffer(req.body)
        ? req.body
        : Buffer.from(typeof req.body === "string" ? req.body : "");

      const verification = verifySep24Signature({
        rawBody,
        headers: req.headers as Record<string, unknown>,
      });

      if (!verification.valid) {
        // The reason is logged, never returned: telling a caller whether the
        // signature was malformed, stale, or simply wrong hands an attacker a
        // free oracle for probing the secret.
        req.log.warn(
          { reason: verification.reason, route: "/api/webhooks/sep24" },
          "rejected SEP-24 callback"
        );
        throw Errors.unauthorized("Invalid webhook signature");
      }

      // Parsing happens only after verification, so an unauthenticated caller
      // can never reach the schema, the database, or the audit log.
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw Errors.badRequest(
          "invalid_webhook_body",
          "Webhook body must be valid JSON"
        );
      }

      const callback = sep24CallbackSchema.parse(payload);
      const result = await applySep24Callback(callback);

      // 200 regardless of whether a session matched or the transition applied:
      // anchors retry non-2xx responses, and re-delivering a callback that was
      // correctly processed as a no-op only amplifies load.
      return reply.code(200).send({
        received: true,
        status: result.status,
        matched: result.matched,
        updated: result.updated,
      });
    }
  );
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
  await app.register(sep24CallbackRoute);
  await app.register(webhookManagementRoutes);
}

async function webhookManagementRoutes(app: FastifyInstance) {
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
      // A group webhook streams the group's financial events (settlements,
      // expense changes) to a caller-supplied URL, so registering one is an
      // administration decision, not an ordinary membership privilege — the
      // same bar as treasury withdrawal and member removal. It also runs
      // inside the same transaction as the row insert so a caller demoted
      // between the check and the write cannot slip an ex-admin's endpoint
      // through (the atomicity convention every other admin action here
      // follows).
      const webhook = await prisma.$transaction(async (tx) => {
        await requireAdmin(body.groupId!, auth.id, tx);

        const count = await tx.webhook.count({
          where: { groupId: body.groupId },
        });
        if (count >= 10) {
          throw Errors.badRequest(
            "webhook_limit_reached",
            "A group can have at most 10 webhooks"
          );
        }

        return tx.webhook.create({
          data: {
            groupId: body.groupId,
            // A group registration belongs to the group, not to whoever
            // created it, so it keeps working after that member leaves.
            userId: null,
            url: body.url,
            secret: createWebhookSecret(),
            events: body.events,
            enabled: true,
          },
        });
      });

      await audit({
        userId: auth.id,
        groupId: body.groupId,
        action: "webhook.register",
        entityType: "webhook",
        entityId: webhook.id,
        metadata: { url: body.url, events: body.events },
      });

      return reply.code(201).send({ webhook: publicWebhook(webhook, true) });
    }

    const webhook = await prisma.webhook.create({
      data: {
        groupId: null,
        // A personal registration stays owned by the caller.
        userId: auth.id,
        url: body.url,
        secret: createWebhookSecret(),
        events: body.events,
        enabled: true,
      },
    });

    return reply.code(201).send({ webhook: publicWebhook(webhook, true) });
  });

  const asMember = { preHandler: requireGroupRole("member", { param: "groupId" }) };
  const asAdmin = { preHandler: requireGroupRole("admin", { param: "groupId" }) };

  app.post("/groups/:groupId/webhooks", asAdmin, async (req) => {
    const auth = requireUser(req);
    const { groupId } = paramsSchema.parse(req.params);
    const body = createSchema.parse(req.body);

    // Same admin gate as POST /api/webhooks with a groupId: the endpoint
    // streams group financial events to a caller-supplied URL. Check and
    // insert run in one transaction for the same reason.
    const webhook = await prisma.$transaction(async (tx) => {
      await requireAdmin(groupId, auth.id, tx);

      const count = await tx.webhook.count({ where: { groupId } });
      if (count >= 10) {
        throw Errors.badRequest(
          "webhook_limit_reached",
          "A group can have at most 10 webhooks"
        );
      }

      return tx.webhook.create({
        data: {
          groupId,
          userId: null,
          url: body.url,
          secret: createWebhookSecret(),
          events: body.events,
          enabled: true,
        },
      });
    });

    await audit({
      userId: auth.id,
      groupId,
      action: "webhook.register",
      entityType: "webhook",
      entityId: webhook.id,
      metadata: { url: body.url, events: body.events },
    });

    return { webhook: publicWebhook(webhook, true) };
  });

  app.get("/groups/:groupId/webhooks", asMember, async (req) => {
    const { groupId } = paramsSchema.parse(req.params);

    const webhooks = await (prisma as any).webhook.findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });

    return { webhooks: webhooks.map((webhook: any) => publicWebhook(webhook)) };
  });

  app.delete("/groups/:groupId/webhooks/:webhookId", asAdmin, async (req) => {
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);

    const webhook = await (prisma as any).webhook.findFirst({
      where: { id: webhookId, groupId },
    });
    if (!webhook) throw Errors.notFound("Webhook not found");

    await (prisma as any).webhook.delete({ where: { id: webhookId } });
    return { deleted: true };
  });

  app.post("/groups/:groupId/webhooks/:webhookId/test", asMember, async (req) => {
    const auth = requireUser(req);
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);

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

  app.get("/groups/:groupId/webhooks/:webhookId/deliveries", asMember, async (req) => {
    const { groupId, webhookId } = webhookParamsSchema.parse(req.params);

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
