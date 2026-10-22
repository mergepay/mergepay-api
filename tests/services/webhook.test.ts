/**
 * Webhook delivery queue.
 *
 * The properties under test are the ones that make delivery reliable rather
 * than best-effort: an event is queued before anything is sent, a retry
 * re-sends the exact bytes that were signed, and a receiver that never
 * acknowledges is given a bounded number of attempts and then left alone.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import crypto from "node:crypto";

const h = vi.hoisted(() => {
  const prisma: any = {
    webhook: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      create: vi.fn(),
    },
    webhookDelivery: {
      createMany: vi.fn(async ({ data }: any) => ({ count: data.length })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    groupMember: { findUnique: vi.fn(async () => ({ role: "member" })) },
    group: { findUnique: vi.fn(async () => ({ id: "group_1" })) },
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  SIGNATURE_HEADER,
  attemptDelivery,
  deliveryBackoffMs,
  processPendingWebhookDeliveries,
  queueWebhookEvent,
} from "../../src/services/webhook";
import { config } from "../../src/config";

const prisma = h.prisma;

const endpoint = (over: Record<string, any> = {}) => ({
  id: "webhook_1",
  url: "https://example.test/hook",
  secret: "shhh",
  enabled: true,
  ...over,
});

const delivery = (over: Record<string, any> = {}) => ({
  id: "delivery_1",
  webhookId: "webhook_1",
  eventType: "settlement.completed",
  payload: JSON.stringify({ eventType: "settlement.completed", data: {} }),
  status: "pending",
  attempts: 0,
  nextAttemptAt: new Date("2026-01-01T00:00:00.000Z"),
  webhook: { url: "https://example.test/hook", secret: "shhh", enabled: true },
  ...over,
});

function jsonResponse(status: number, body = "ok"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.webhook.findMany.mockResolvedValue([]);
  prisma.webhookDelivery.findMany.mockResolvedValue([]);
  prisma.webhookDelivery.createMany.mockImplementation(async ({ data }: any) => ({
    count: data.length,
  }));
  prisma.webhookDelivery.update.mockResolvedValue({});
  prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 1 });
});

describe("queueWebhookEvent", () => {
  it("queues one pending delivery per subscribed endpoint", async () => {
    prisma.webhook.findMany.mockResolvedValue([
      endpoint({ id: "webhook_1" }),
      endpoint({ id: "webhook_2" }),
    ]);

    const queued = await queueWebhookEvent(
      "settlement.completed",
      { settlementId: "s_1" },
      "group_1"
    );

    expect(queued).toBe(2);
    const rows = prisma.webhookDelivery.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("returns without sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    prisma.webhook.findMany.mockResolvedValue([endpoint()]);

    await queueWebhookEvent("settlement.completed", {}, "group_1");

    // Delivery is the worker's job; the request path only writes a row.
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("only selects endpoints subscribed to the event", async () => {
    await queueWebhookEvent("settlement.failed", {}, "group_1");

    const where = prisma.webhook.findMany.mock.calls[0][0].where;
    expect(where.enabled).toBe(true);
    expect(where.events).toEqual({ has: "settlement.failed" });
  });

  it("queues nothing when no endpoint is listening", async () => {
    prisma.webhook.findMany.mockResolvedValue([]);

    const queued = await queueWebhookEvent("settlement.completed", {}, "group_1");

    expect(queued).toBe(0);
    expect(prisma.webhookDelivery.createMany).not.toHaveBeenCalled();
  });

  it("does not queue when the event is scoped to nobody", async () => {
    const queued = await queueWebhookEvent("settlement.completed", {});

    expect(queued).toBe(0);
    expect(prisma.webhook.findMany).not.toHaveBeenCalled();
  });

  it("stores the serialized body so a retry re-sends identical bytes", async () => {
    prisma.webhook.findMany.mockResolvedValue([endpoint()]);

    await queueWebhookEvent("settlement.completed", { settlementId: "s_1" }, "group_1");

    const row = prisma.webhookDelivery.createMany.mock.calls[0][0].data[0];
    const parsed = JSON.parse(row.payload);
    expect(parsed).toMatchObject({
      eventType: "settlement.completed",
      data: { settlementId: "s_1" },
    });
    expect(parsed.timestamp).toEqual(expect.any(String));
  });
});

describe("deliveryBackoffMs", () => {
  it("does not delay the first attempt", () => {
    expect(deliveryBackoffMs(1)).toBe(0);
  });

  it("grows exponentially from the configured base", () => {
    const base = config.WEBHOOK_RETRY_BASE_DELAY_MS;
    expect(deliveryBackoffMs(2)).toBe(base);
    expect(deliveryBackoffMs(3)).toBe(base * 2);
    expect(deliveryBackoffMs(4)).toBe(base * 4);
  });
});

describe("attemptDelivery", () => {
  it("signs the exact body with the endpoint's secret", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200));
    vi.stubGlobal("fetch", fetchMock);

    const row = delivery();
    await attemptDelivery({
      id: row.id,
      webhookId: row.webhookId,
      eventType: row.eventType,
      payload: row.payload,
      attempts: 0,
      webhook: { url: row.webhook.url, secret: row.webhook.secret },
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://example.test/hook");
    expect(init.body).toBe(row.payload);
    expect(init.headers[SIGNATURE_HEADER]).toBe(
      crypto.createHmac("sha256", "shhh").update(row.payload).digest("hex")
    );
    vi.unstubAllGlobals();
  });

  it("marks a 200 response delivered", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));

    const row = delivery();
    const status = await attemptDelivery({ ...row, webhook: row.webhook });

    expect(status).toBe("delivered");
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "delivered",
          attempts: 1,
          responseStatusCode: 200,
          nextAttemptAt: null,
        }),
      })
    );
    vi.unstubAllGlobals();
  });

  it("keeps a 500 response pending and schedules a retry", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500, "boom")));

    const row = delivery();
    const status = await attemptDelivery({ ...row, webhook: row.webhook });

    expect(status).toBe("pending");
    const data = prisma.webhookDelivery.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "pending", attempts: 1, responseStatusCode: 500 });
    expect(data.nextAttemptAt).toBeInstanceOf(Date);
    vi.unstubAllGlobals();
  });

  it("marks the delivery failed once the attempt budget is spent", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(500)));

    const row = delivery({ attempts: config.WEBHOOK_MAX_ATTEMPTS - 1 });
    const status = await attemptDelivery({ ...row, webhook: row.webhook });

    expect(status).toBe("failed");
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "failed",
          attempts: config.WEBHOOK_MAX_ATTEMPTS,
          // Terminal: never retried again.
          nextAttemptAt: null,
        }),
      })
    );
    vi.unstubAllGlobals();
  });

  it("treats a transport failure like a non-acknowledgement", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const row = delivery();
    const status = await attemptDelivery({ ...row, webhook: row.webhook });

    expect(status).toBe("pending");
    const data = prisma.webhookDelivery.update.mock.calls[0][0].data;
    expect(data.responseStatusCode).toBeNull();
    expect(data.responseBody).toContain("ECONNREFUSED");
    vi.unstubAllGlobals();
  });

  it("bounds the stored response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(500, "x".repeat(100_000)))
    );

    const row = delivery();
    await attemptDelivery({ ...row, webhook: row.webhook });

    const data = prisma.webhookDelivery.update.mock.calls[0][0].data;
    expect(data.responseBody.length).toBeLessThanOrEqual(16_384);
    vi.unstubAllGlobals();
  });

  it("releases the lease whatever the outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));

    const row = delivery();
    await attemptDelivery({ ...row, webhook: row.webhook });

    const data = prisma.webhookDelivery.update.mock.calls[0][0].data;
    expect(data.claimedBy).toBeNull();
    expect(data.leaseExpiresAt).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("processPendingWebhookDeliveries", () => {
  it("only claims pending deliveries whose backoff has elapsed", async () => {
    await processPendingWebhookDeliveries();

    const where = prisma.webhookDelivery.findMany.mock.calls[0][0].where;
    expect(where.status).toBe("pending");
    expect(where.nextAttemptAt.lte).toBeInstanceOf(Date);
  });

  it("sends a claimed delivery and reports the outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));
    prisma.webhookDelivery.findMany.mockResolvedValue([delivery()]);

    const result = await processPendingWebhookDeliveries();

    expect(result).toMatchObject({ attempted: 1, delivered: 1, failed: 0 });
    vi.unstubAllGlobals();
  });

  it("skips a delivery another worker already claimed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    prisma.webhookDelivery.findMany.mockResolvedValue([delivery()]);
    // The conditional claim matched nothing: someone else owns this row.
    prisma.webhookDelivery.updateMany.mockResolvedValue({ count: 0 });

    const result = await processPendingWebhookDeliveries();

    expect(result.attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("guards the claim on the attempt count it read", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200)));
    prisma.webhookDelivery.findMany.mockResolvedValue([delivery({ attempts: 2 })]);

    await processPendingWebhookDeliveries();

    const where = prisma.webhookDelivery.updateMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "pending", attempts: 2 });
    vi.unstubAllGlobals();
  });

  it("fails a delivery whose endpoint was disabled after queueing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    prisma.webhookDelivery.findMany.mockResolvedValue([
      delivery({
        webhook: { url: "https://example.test/hook", secret: "s", enabled: false },
      }),
    ]);

    const result = await processPendingWebhookDeliveries();

    expect(result.failed).toBe(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "failed" }),
      })
    );
    vi.unstubAllGlobals();
  });

  it("bounds how many deliveries one cycle takes on", async () => {
    await processPendingWebhookDeliveries(5);

    expect(prisma.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 })
    );
  });
});
