import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    webhook: {
      create: vi.fn(),
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      delete: vi.fn(async ({ where }: any) => ({ id: where.id })),
    },
    webhookDelivery: { createMany: vi.fn(async () => ({ count: 0 })) },
    groupMember: { findUnique: vi.fn() },
    group: { findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({ id: "audit_1" })) },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
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
  // A fresh app per case: the limiter's counter lives in the app instance, and
  // these cases exercise registration validation, not throttling — #668 gave
  // this route a per-user tier, so they must not inherit each other's bucket.
  app = await buildApp();

  // Group registration is an administrative action (#700), so the default
  // caller is an admin; the non-admin refusal test overrides this to member.
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "admin",
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

afterEach(async () => {
  await app.close();
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

  it("registers a group endpoint for an admin", async () => {
    const res = await register({ groupId: GROUP_ID });

    expect(res.statusCode).toBe(201);
    const data = prisma.webhook.create.mock.calls[0][0].data;
    // Owned by the group, so it keeps working after the creator leaves.
    expect(data).toMatchObject({ groupId: GROUP_ID, userId: null });
    // Registering is an administrative action, so it is audited.
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("refuses a group endpoint for a non-admin member", async () => {
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: GROUP_ID,
      userId: USER_ID,
      role: "member",
    });

    const res = await register({ groupId: GROUP_ID });

    expect(res.statusCode).toBe(403);
    expect(prisma.webhook.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("refuses to register for a group the caller does not belong to", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });

    const res = await register({ groupId: GROUP_ID });

    // 403, not 404: the group exists, the caller just isn't a member.
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
    expect(res.json().error.code).toBe("WEBHOOK_LIMIT_REACHED");
    expect(prisma.webhook.create).not.toHaveBeenCalled();
  });
});

describe("DELETE /groups/:groupId/webhooks/:webhookId", () => {
  function deregister(headers = authHeader()) {
    return app.inject({
      method: "DELETE",
      url: `/groups/${GROUP_ID}/webhooks/webhook_1`,
      headers,
    });
  }

  beforeEach(() => {
    prisma.webhook.findFirst.mockResolvedValue({
      id: "webhook_1",
      groupId: GROUP_ID,
      url: "https://example.test/hook",
      events: ["settlement.completed"],
    });
  });

  it("removes the endpoint and audits the removal against the group", async () => {
    const res = await deregister();

    expect(res.statusCode).toBe(200);
    expect(prisma.webhook.delete).toHaveBeenCalledWith({ where: { id: "webhook_1" } });
    // The row itself is gone, so the audit record is the only place the group's
    // trail can still say which URL stopped receiving its events.
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "webhook.deregister",
          userId: USER_ID,
          groupId: GROUP_ID,
          entityType: "webhook",
          entityId: "webhook_1",
          metadata: expect.objectContaining({ url: "https://example.test/hook" }),
        }),
      })
    );
  });

  it("refuses a non-admin without deleting or auditing", async () => {
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: GROUP_ID,
      userId: USER_ID,
      role: "member",
    });

    const res = await deregister();

    expect(res.statusCode).toBe(403);
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("404s for a webhook the group does not own without auditing", async () => {
    prisma.webhook.findFirst.mockResolvedValue(null);

    const res = await deregister();

    expect(res.statusCode).toBe(404);
    expect(prisma.webhook.delete).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
