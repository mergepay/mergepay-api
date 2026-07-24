import crypto from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { eventBus, type MergepayEvent } from "./event";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 5000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

interface WebhookRecord {
  id: string;
  url: string;
  secret: string;
  events: string[];
  enabled: boolean;
}

interface EventEnvelope extends MergepayEvent {
  id: string;
  timestamp: string;
}

function signedPayload(secret: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

function createEnvelope(event: MergepayEvent): EventEnvelope {
  return {
    ...event,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
}

async function recordDelivery(data: {
  webhookId: string;
  eventType: string;
  payload: Record<string, unknown>;
  responseStatusCode: number | null;
  responseBody: string | null;
  success: boolean;
  attempts: number;
}): Promise<void> {
  await prisma.webhookDelivery.create({
    data: {
      webhookId: data.webhookId,
      eventType: data.eventType,
      payload: data.payload as Prisma.InputJsonValue,
      responseStatusCode: data.responseStatusCode,
      responseBody: data.responseBody,
      success: data.success,
      attempts: data.attempts,
    },
  });
}

export async function deliverWebhook(
  webhook: WebhookRecord,
  event: MergepayEvent | EventEnvelope,
): Promise<void> {
  const envelope: EventEnvelope =
    "id" in event && "timestamp" in event ? event : createEnvelope(event);
  const payloadObject = {
    id: envelope.id,
    eventType: envelope.eventType,
    data: envelope.payload,
    timestamp: envelope.timestamp,
  };
  const payload = JSON.stringify(payloadObject);

  if (Buffer.byteLength(payload, "utf8") > MAX_PAYLOAD_BYTES) {
    await recordDelivery({
      webhookId: webhook.id,
      eventType: envelope.eventType,
      payload: payloadObject,
      responseStatusCode: null,
      responseBody: "Payload exceeds the 1MB webhook limit",
      success: false,
      attempts: 0,
    });
    return;
  }

  let responseStatusCode: number | null = null;
  let responseBody: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Mergepay-Webhooks/1.0",
          "X-Mergepay-Signature": signedPayload(webhook.secret, payload),
        },
        body: payload,
        signal: controller.signal,
      });

      responseStatusCode = response.status;
      responseBody = (await response.text()).slice(0, 10000);

      if (response.ok) {
        await recordDelivery({
          webhookId: webhook.id,
          eventType: envelope.eventType,
          payload: payloadObject,
          responseStatusCode,
          responseBody,
          success: true,
          attempts: attempt,
        });
        return;
      }
    } catch (error) {
      responseStatusCode = null;
      responseBody = error instanceof Error ? error.message : "Webhook request failed";
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt - 1]));
    }
  }

  await recordDelivery({
    webhookId: webhook.id,
    eventType: envelope.eventType,
    payload: payloadObject,
    responseStatusCode,
    responseBody,
    success: false,
    attempts: MAX_ATTEMPTS,
  });
}

export async function dispatchEvent(event: MergepayEvent): Promise<void> {
  const where: Prisma.WebhookWhereInput = {
    enabled: true,
    events: { has: event.eventType },
  };

  if (event.groupId) {
    where.OR = [
      { groupId: event.groupId },
      ...(event.userId ? [{ groupId: null, userId: event.userId }] : []),
    ];
  } else if (event.userId) {
    where.userId = event.userId;
  } else {
    return;
  }

  const webhooks = await prisma.webhook.findMany({ where });
  const envelope = createEnvelope(event);
  await Promise.allSettled(webhooks.map((webhook) => deliverWebhook(webhook, envelope)));
}

let dispatcherStarted = false;

export function startWebhookDispatcher(): void {
  if (dispatcherStarted) return;
  dispatcherStarted = true;
  eventBus.on("event", (event: MergepayEvent) => {
    void dispatchEvent(event).catch(() => undefined);
  });
}

startWebhookDispatcher();
