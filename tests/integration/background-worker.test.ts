import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prisma } from "../../src/db";
import { deliverPendingWebhooks } from "../../src/worker";

const testPrefix = `worker-${randomUUID()}`;
const createdGroupIds: string[] = [];

async function startWebhookServer(statusCode: number): Promise<{
  server: Server;
  url: string;
  requests: string[];
}> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = statusCode;
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("Test webhook server did not expose a port");
  }

  return { server, url: `http://127.0.0.1:${address.port}`, requests };
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function seedPendingDelivery(url: string) {
  const user = await prisma.user.create({
    data: {
      stellarPublicKey: `G${randomUUID().replaceAll("-", "").slice(0, 55)}`,
      displayName: `${testPrefix}-user`,
    },
  });
  const group = await prisma.group.create({
    data: {
      name: `${testPrefix}-group`,
      createdByUserId: user.id,
      members: { create: { userId: user.id, role: "admin" } },
    },
  });
  createdGroupIds.push(group.id);
  const webhook = await prisma.webhook.create({
    data: {
      groupId: group.id,
      url,
      secret: "integration-test-secret",
      events: ["settlement.confirmed"],
    },
  });
  const delivery = await prisma.webhookDelivery.create({
    data: {
      webhookId: webhook.id,
      eventType: "settlement.confirmed",
      payload: JSON.stringify({ eventType: "settlement.confirmed", data: { groupId: group.id } }),
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    },
  });

  return { delivery, groupId: group.id, userId: user.id };
}

afterEach(async () => {
  await prisma.group.deleteMany({ where: { id: { in: createdGroupIds.splice(0) } } });
});

describe("background worker webhook jobs", () => {
  it("delivers a pending notification and clears its lease", async () => {
    const endpoint = await startWebhookServer(204);
    try {
      const { delivery } = await seedPendingDelivery(endpoint.url);

      await deliverPendingWebhooks();

      const completed = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
      expect(completed).toMatchObject({
        status: "delivered",
        attempts: 1,
        claimedBy: null,
        leaseExpiresAt: null,
      });
      expect(endpoint.requests).toHaveLength(1);
    } finally {
      await closeServer(endpoint.server);
    }
  }, 30000);

  it("keeps a failed notification retryable without leaving a lease", async () => {
    const endpoint = await startWebhookServer(503);
    try {
      const { delivery } = await seedPendingDelivery(endpoint.url);

      await deliverPendingWebhooks();

      const failedAttempt = await prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
      expect(failedAttempt).toMatchObject({
        status: "pending",
        attempts: 1,
        claimedBy: null,
        leaseExpiresAt: null,
      });
      expect(failedAttempt?.nextAttemptAt).not.toBeNull();
    } finally {
      await closeServer(endpoint.server);
    }
  }, 30000);
});