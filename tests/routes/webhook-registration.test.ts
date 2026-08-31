import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    webhook: {
      create: vi.fn(),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    webhookDelivery: { createMany: vi.fn(async () => ({ count: 0 })) },
    groupMember: { findUnique: vi.fn() },
    group: { findUnique: vi.fn() },
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";

const prisma = h.prisma;
const USER_ID = "user_1";
const GROUP_ID = "group_1";

let app: Awaited<ReturnType<typeof buildApp>>;

function authHeader(userId = USER_ID) {
  const token = signToken({
    id: userId,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

function register(body: Record<string, unknown>, headers = authHeader()) {
  return app.inject({
    method: "POST",
    url: "/api/webhooks",
    headers,
    payload: {
      url: "https://example.test/hook",
      events: ["settlement.completed"],
      ...body,
    },
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  });
  prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });
  prisma.webhook.count.mockResolvedValue(0);
  prisma.webhook.create.mockImplementation(async ({ data }: any) => ({
    id: "webhook_1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...data,
  }));
});

describe("POST /api/webhooks", () => {
  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      payload: { url: "https://example.test/hook", events: ["settlement.completed"] },
    });

    expect(res.statusCode).toBe(401);
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("registers a personal endpoint when no group is given", async () => {
    const res = await register({});

    expect(res.statusCode).toBe(201);
    const data = prisma.webhook.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ groupId: null, userId: USER_ID, enabled: true });
  });

  it("registers a group endpoint for a member", async () => {
    const res = await register({ groupId: GROUP_ID });

    expect(res.statusCode).toBe(201);
    const data = prisma.webhook.create.mock.calls[0][0].data;
    // Owned by the group, so it keeps working after the creator leaves.
    expect(data).toMatchObject({ groupId: GROUP_ID, userId: null });
  });

  it("refuses to register for a group the caller does not belong to", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });

    const res = await register({ groupId: GROUP_ID });

    expect(res.statusCode).toBe(403);
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("returns the signing secret exactly once, at creation", async () => {
    const res = await register({});

    const body = res.json();
    expect(body.webhook.secret).toEqual(expect.any(String));
    expect(body.webhook.secret.length).toBeGreaterThan(32);
  });

  it("generates a distinct secret per endpoint", async () => {
    const first = await register({});
    const second = await register({});

    expect(first.json().webhook.secret).not.toBe(second.json().webhook.secret);
  });

  it("rejects a non-HTTP callback URL", async () => {
    const res = await register({ url: "ftp://example.test/hook" });

    expect(res.statusCode).toBe(400);
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown event type", async () => {
    const res = await register({ events: ["not.a.real.event"] });

    expect(res.statusCode).toBe(400);
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });

  it("rejects an empty event list", async () => {
    const res = await register({ events: [] });

    expect(res.statusCode).toBe(400);
  });

  it("rejects duplicate event types", async () => {
    const res = await register({
      events: ["settlement.completed", "settlement.completed"],
    });

    expect(res.statusCode).toBe(400);
  });

  it("enforces the per-group endpoint limit", async () => {
    prisma.webhook.count.mockResolvedValue(10);

    const res = await register({ groupId: GROUP_ID });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("WEBHOOK_LIMIT_REACHED");
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });
});
