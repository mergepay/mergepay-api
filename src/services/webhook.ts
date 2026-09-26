/**
 * Webhook delivery.
 *
 * External integrations need to know when a settlement changes state without
 * polling for it. Delivery is queued rather than performed inline: a receiver
 * that is slow, unreachable, or retrying would otherwise hold an API request
 * open for the length of its own backoff, making Mergepay's latency a function
 * of the least reliable endpoint any group registered.
 *
 * ## The queue
 *
 * `queueWebhookEvent` writes one `pending` WebhookDelivery row per matching
 * endpoint and returns. The worker claims those rows, sends them, and records
 * the outcome. Because the row is written before any request is attempted, an
 * event is never lost to a process that died mid-delivery — the row is still
 * pending and the next cycle picks it up.
 *
 * The serialized body is stored on the row rather than rebuilt per attempt. A
 * re-serialized payload would produce different bytes, and therefore a
 * different HMAC, than the signature the receiver was told to expect.
 *
 * ## Signing
 *
 * Every request carries `X-Mergepay-Signature`: the SHA-256 HMAC of the exact
 * request body, keyed by the endpoint's own secret. A receiver recomputes it to
 * confirm both that Mergepay sent the payload and that nothing altered it.
 */
import crypto from "node:crypto";
import { prisma } from "../db";
import { config } from "../config";
import {
  eventBus,
  type MergepayEvent,
  type WebhookEventType,
} from "./event";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
const DELIVERY_TIMEOUT_MS = 5_000;

/** Delivery lifecycle. `pending` is the only non-terminal state. */
export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

/** Header carrying the HMAC-SHA256 signature of the request body. */
export const SIGNATURE_HEADER = "x-mergepay-signature";

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

/**
 * Backoff before attempt `attempt` (1-based). Attempt 1 is immediate.
 *
 * Exponential from the configured base, so a receiver that is briefly down
 * gets a fast retry while one that is genuinely broken is backed away from
 * rather than hammered.
 */
export function deliveryBackoffMs(attempt: number): number {
  if (attempt <= 1) return 0;
  return config.WEBHOOK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 2);
}

/**
 * Perform one delivery attempt and record its outcome.
 *
 * Returns the resulting status. A non-2xx response and a transport failure are
 * treated the same way — the receiver did not acknowledge — and both consume an
 * attempt. Once the budget is spent the row moves to `failed` and is never
 * retried again, which is what stops a permanently broken endpoint from being
 * retried forever.
 */
export async function attemptDelivery(delivery: {
  id: string;
  webhookId: string;
  eventType: string;
  payload: string;
  attempts: number;
  webhook: { url: string; secret: string };
}): Promise<WebhookDeliveryStatus> {
  const attempt = delivery.attempts + 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  let statusCode: number | null = null;
  let responseBody: string | null = null;
  let delivered = false;

  try {
    const response = await fetch(delivery.webhook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Mergepay-Webhooks/1.0",
        // Signs the stored bytes, which are exactly the bytes being sent.
        [SIGNATURE_HEADER]: createSignature(
          delivery.payload,
          delivery.webhook.secret
        ),
      },
      body: delivery.payload,
      signal: controller.signal,
    });

    statusCode = response.status;
    // Bounded: a receiver returning a large error page must not be able to
    // write an unbounded row.
    responseBody = (await response.text()).slice(0, 16_384);
    delivered = response.ok;
  } catch (error) {
    responseBody =
      error instanceof Error ? error.message : "Webhook delivery failed";
  } finally {
    clearTimeout(timeout);
  }

  const exhausted = attempt >= config.WEBHOOK_MAX_ATTEMPTS;
  const status: WebhookDeliveryStatus = delivered
    ? "delivered"
    : exhausted
      ? "failed"
      : "pending";

  await prisma.webhookDelivery.update({
    where: { id: delivery.id },
    data: {
      status,
      attempts: attempt,
      responseStatusCode: statusCode,
      responseBody,
      lastAttemptAt: new Date(),
      // Terminal rows carry no next attempt, so the worker's claim query
      // ignores them without needing to filter on status alone.
      nextAttemptAt:
        status === "pending"
          ? new Date(Date.now() + deliveryBackoffMs(attempt + 1))
          : null,
      claimedBy: null,
      leaseExpiresAt: null,
    },
  });

  return status;
}

async function findWebhook(webhookId: string): Promise<WebhookRecord | null> {
  return prisma.webhook.findFirst({
    where: { id: webhookId, enabled: true },
    select: { id: true, url: true, secret: true, enabled: true },
  });
}

/** Enqueue a delivery for one specific endpoint. Used by the test-fire route. */
export async function dispatchWebhook(
  webhookId: string,
  eventType: WebhookEventType,
  payload: unknown
): Promise<void> {
  const webhook = await findWebhook(webhookId);
  if (!webhook) {
    throw new Error("Webhook not found or disabled");
  }

  await enqueue([webhook], eventType, serialisePayload(eventType, payload));
}

/**
 * Enqueue a delivery for every endpoint subscribed to this event.
 *
 * Returns the number of deliveries queued, so a caller (or a test) can tell
 * "nobody was listening" from "queued and awaiting the worker".
 */
export async function queueWebhookEvent(
  eventType: WebhookEventType,
  payload: unknown,
  groupId?: string,
  userId?: string
): Promise<number> {
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
    return 0;
  }

  const webhooks = await prisma.webhook.findMany({
    where,
    select: { id: true, url: true, secret: true, enabled: true },
  });

  return enqueue(webhooks, eventType, body);
}

/**
 * Retained name for the previous inline-dispatch entry point. It now queues
 * rather than delivering, so callers in the request path return immediately.
 */
export const dispatchEvent = queueWebhookEvent;

/** Write one pending delivery row per endpoint. */
async function enqueue(
  webhooks: WebhookRecord[],
  eventType: WebhookEventType,
  body: string
): Promise<number> {
  if (webhooks.length === 0) return 0;

  // Queued eligible immediately: the first attempt should not wait for a
  // backoff it has not earned.
  const now = new Date();

  const { count } = await prisma.webhookDelivery.createMany({
    data: webhooks.map((webhook) => ({
      webhookId: webhook.id,
      eventType,
      payload: body,
      status: "pending",
      attempts: 0,
      nextAttemptAt: now,
    })),
  });

  return count;
}

/**
 * Drain the delivery queue.
 *
 * Called from the worker cycle. Each row is claimed with a conditional update
 * carrying a lease, so two worker processes can never send the same delivery
 * twice; a worker that crashes leaves its lease behind and the row becomes
 * claimable again once it lapses.
 */
export async function processPendingWebhookDeliveries(
  batchSize: number = config.WORKER_BATCH_SIZE
): Promise<{ delivered: number; failed: number; attempted: number }> {
  const now = new Date();

  const due = await prisma.webhookDelivery.findMany({
    where: {
      status: "pending",
      nextAttemptAt: { lte: now },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    orderBy: { nextAttemptAt: "asc" },
    take: batchSize,
    include: { webhook: { select: { url: true, secret: true, enabled: true } } },
  });

  let delivered = 0;
  let failed = 0;
  let attempted = 0;

  for (const row of due) {
    // An endpoint disabled after the event was queued should not be called.
    if (!row.webhook.enabled) {
      await prisma.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: "failed",
          responseBody: "Endpoint disabled before delivery",
          nextAttemptAt: null,
        },
      });
      failed += 1;
      continue;
    }

    if (!(await claimDelivery(row.id, row.attempts))) continue;

    attempted += 1;
    const status = await attemptDelivery({
      id: row.id,
      webhookId: row.webhookId,
      eventType: row.eventType,
      payload: row.payload,
      attempts: row.attempts,
      webhook: { url: row.webhook.url, secret: row.webhook.secret },
    });

    if (status === "delivered") delivered += 1;
    if (status === "failed") failed += 1;
  }

  return { delivered, failed, attempted };
}

/**
 * Take exclusive ownership of one delivery.
 *
 * The guard includes the attempt count this worker read, so a row another
 * process already advanced is never re-sent from a stale view.
 */
async function claimDelivery(id: string, attempts: number): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.webhookDelivery.updateMany({
    where: {
      id,
      status: "pending",
      attempts,
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
    },
    data: {
      claimedBy: WORKER_ID,
      leaseExpiresAt: new Date(now.getTime() + config.WORKER_LEASE_TIMEOUT_MS),
    },
  });
  return count === 1;
}

/** Identifies this process in delivery leases. */
const WORKER_ID = crypto.randomUUID();

let dispatcherStarted = false;

/**
 * Bridge domain events onto the delivery queue.
 *
 * Queueing is a fast database write, so this stays on the event bus rather than
 * becoming a second scheduled job — the work of actually sending is what moved
 * to the worker.
 */
export function startWebhookDispatcher(): void {
  if (dispatcherStarted) return;
  dispatcherStarted = true;

  eventBus.on("event", (event: MergepayEvent) => {
    void queueWebhookEvent(
      event.eventType,
      event.payload,
      event.groupId,
      event.userId
    ).catch(() => undefined);
  });
}

startWebhookDispatcher();

export function createWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}
