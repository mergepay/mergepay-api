import crypto from "node:crypto";
import { prisma } from "../db";
import {
  eventBus,
  type MergepayEvent,
  type WebhookEventType,
} from "./event";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;

interface WebhookRecord {
  id: string;
  url: string;
  secret: string;
  enabled: boolean;
}

function serialisePayload(eventType: WebhookEventType, payload: unknown): string {
  const body = JSON.stringify({
    eventType,
    data: payload,
    timestamp: new Date().toISOString(),
  });

  if (Buffer.byteLength(body, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("Webhook payload exceeds the 1MB limit");
  }

  return body;
}

function createSignature(body: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

async function deliver(
  webhook: WebhookRecord,
  eventType: WebhookEventType,
  body: string
): Promise<void> {
  const delivery = await (prisma as any).webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      eventType,
      payload: body,
      responseStatusCode: null,
      responseBody: null,
      success: false,
      attempts: 0,
    },
  });

  let lastStatusCode: number | null = null;
  let lastResponseBody: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, RETRY_DELAYS_MS[attempt - 2]);
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mergepay-Webhooks/1.0",
          "x-mergepay-signature": createSignature(body, webhook.secret),
        },
        body,
        signal: controller.signal,
      });

      lastStatusCode = response.status;
      lastResponseBody = (await response.text()).slice(0, 16_384);

      if (response.ok) {
        await (prisma as any).webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            responseStatusCode: lastStatusCode,
            responseBody: lastResponseBody,
            success: true,
            attempts: attempt,
          },
        });
        return;
      }
    } catch (error) {
      lastStatusCode = null;
      lastResponseBody =
        error instanceof Error ? error.message : "Webhook delivery failed";
    } finally {
      clearTimeout(timeout);
    }

    await (prisma as any).webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        responseStatusCode: lastStatusCode,
        responseBody: lastResponseBody,
        success: false,
        attempts: attempt,
      },
    });
  }
}

async function findWebhook(webhookId: string): Promise<WebhookRecord | null> {
  return (await (prisma as any).webhook.findFirst({
    where: { id: webhookId, enabled: true },
    select: { id: true, url: true, secret: true, enabled: true },
  })) as WebhookRecord | null;
}

export async function dispatchWebhook(
  webhookId: string,
  eventType: WebhookEventType,
  payload: unknown
): Promise<void> {
  const webhook = await findWebhook(webhookId);
  if (!webhook) {
    throw new Error("Webhook not found or disabled");
  }

  await deliver(webhook, eventType, serialisePayload(eventType, payload));
}

export async function dispatchEvent(
  eventType: WebhookEventType,
  payload: unknown,
  groupId?: string,
  userId?: string
): Promise<void> {
  const body = serialisePayload(eventType, payload);
  const where: Record<string, unknown> = {
    enabled: true,
    events: { has: eventType },
  };

  if (groupId && userId) {
    where.OR = [
      { groupId, userId: null },
      { groupId: null, userId },
      { groupId, userId },
    ];
  } else if (groupId) {
    where.groupId = groupId;
  } else if (userId) {
    where.userId = userId;
  } else {
    return;
  }

  const webhooks = (await (prisma as any).webhook.findMany({
    where,
    select: { id: true, url: true, secret: true, enabled: true },
  })) as WebhookRecord[];

  await Promise.allSettled(
    webhooks.map((webhook) => deliver(webhook, eventType, body))
  );
}

let dispatcherStarted = false;
let dispatchQueue = Promise.resolve();

export function startWebhookDispatcher(): void {
  if (dispatcherStarted) return;
  dispatcherStarted = true;

  eventBus.on("event", (event: MergepayEvent) => {
    dispatchQueue = dispatchQueue
      .then(() =>
        dispatchEvent(
          event.eventType,
          event.payload,
          event.groupId,
          event.userId
        )
      )
      .catch(() => undefined);
  });
}

startWebhookDispatcher();

export function createWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
