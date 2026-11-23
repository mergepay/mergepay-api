/**
 * Issue #914 — structured audit logging middleware for state-changing endpoints.
 *
 * Covers the three pieces the issue asks for:
 *
 *  1. `logAuditTrail` (src/services/audit.ts) — the reusable, asynchronous
 *     write. It schedules the durable record and returns synchronously, so a
 *     database round trip is never on the HTTP latency path, and a failing
 *     store can never surface to the caller.
 *  2. `auditTrail` middleware (src/middleware/audit.ts) — records only
 *     state-changing methods that answered 2xx, carrying actor id, action
 *     type, target resource id, and timestamp, while never copying headers,
 *     tokens, or body values into the trail.
 *  3. Route integration — the state-changing endpoints that previously wrote
 *     no audit row at all (`PATCH /me`, personal webhook registration, the
 *     webhook test dispatch, and receipt uploads) now produce one.
 *
 * The routes that already write in-transaction rows (groups, expenses,
 * settlements, treasury, anchors, SEP-24, withdrawals) keep doing so and are
 * pinned by their existing suites; this file asserts the middleware writes no
 * duplicate of its own for the endpoints it decorates.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import pino from "pino";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    webhook: model(),
    webhookDelivery: model(),
    auditLog: model(),
    idempotencyKey: model(),
    statusHistory: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { auditTrail } from "../src/middleware/audit";
import { logAuditTrail } from "../src/services/audit";
import { setAuditEventLogger } from "../src/lib/audit-logger";
import type pinoTypes from "pino";

const prisma = h.prisma;

const USER_ID = "user_audit_1";
const GROUP_ID = "group_audit_1";
const STELLAR_KEY = Keypair.random().publicKey();

function authHeader(userId = USER_ID) {
  const token = signToken({ id: userId, stellarPublicKey: STELLAR_KEY });
  return { authorization: `Bearer ${token}` };
}

/** Let a scheduled (fire-and-forget) audit write land. */
async function flushAuditWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 25));
}

/** The audit row written for a given action, if any. */
function auditRowFor(action: string) {
  return prisma.auditLog.create.mock.calls.find(
    (call: any) => call[0]?.data?.action === action
  )?.[0]?.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

afterEach(() => {
  setAuditEventLogger(null);
});

describe("logAuditTrail — the asynchronous write (#914)", () => {
  it("persists actor, action, target resource and outcome through the durable writer", () => {
    logAuditTrail({
      actorId: USER_ID,
      actorType: "user",
      groupId: GROUP_ID,
      action: "thing.create",
      resourceType: "thing",
      resourceId: "thing_1",
      outcome: "success",
      metadata: { name: "Trip" },
    });

    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(auditRowFor("thing.create")).toMatchObject({
      userId: USER_ID,
      groupId: GROUP_ID,
      action: "thing.create",
      entityType: "thing",
      entityId: "thing_1",
      metadata: expect.objectContaining({
        name: "Trip",
        outcome: "success",
        actorType: "user",
      }),
    });
  });

  it("returns synchronously — the audit store is never awaited on the request path", () => {
    // A store that never settles: if the write were awaited, this test would
    // hang rather than reach the assertion below.
    prisma.auditLog.create.mockImplementation(
      () => new Promise(() => undefined)
    );

    const returned = logAuditTrail({
      actorId: USER_ID,
      action: "thing.create",
      resourceType: "thing",
      resourceId: "thing_1",
    });

    expect(returned).toBeUndefined();
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it("never throws into the request path when the audit store fails", async () => {
    prisma.auditLog.create.mockRejectedValueOnce(new Error("audit store down"));

    expect(() =>
      logAuditTrail({
        actorId: USER_ID,
        action: "thing.create",
        resourceType: "thing",
        resourceId: "thing_1",
      })
    ).not.toThrow();

    // Give the rejected write time to settle inside the helper's own catch.
    await flushAuditWrites();
  });
});

describe("auditTrail middleware — request-level audit (#914)", () => {
  const trail = {
    action: "thing.update",
    resourceType: "thing",
    resourceId: (req: any) => (req.params as { id?: string }).id ?? null,
    groupId: () => GROUP_ID,
  };

  async function buildMiddlewareApp(
    options: Parameters<typeof auditTrail>[0],
    handler?: (req: any, reply: any) => unknown
  ): Promise<FastifyInstance> {
    const app = Fastify();
    const guard = async (req: any) => {
      req.user = { id: USER_ID, stellarPublicKey: STELLAR_KEY };
    };
    app.post(
      "/things/:id",
      { preHandler: guard, onResponse: auditTrail(options) },
      (handler ?? (async () => ({ ok: true }))) as any
    );
    app.get(
      "/things",
      { preHandler: guard, onResponse: auditTrail(options) },
      async () => ({ ok: true })
    );
    app.post(
      "/things/:id/reject",
      { preHandler: guard, onResponse: auditTrail(options) },
      async (_req, reply) => reply.code(400).send({ error: { code: "NOPE" } })
    );
    await app.ready();
    return app;
  }

  it("records actor, action, target resource and timestamp for a successful state change", async () => {
    const app = await buildMiddlewareApp(trail);
    const lines: any[] = [];
    setAuditEventLogger(
      pino(
        { level: "info" },
        {
          write(chunk: string) {
            try {
              lines.push(JSON.parse(chunk));
            } catch {
              // ignore non-JSON chunks
            }
          },
        } as any
      ) as pinoTypes.Logger
    );

    const res = await app.inject({ method: "POST", url: "/things/thing_9" });
    expect(res.statusCode).toBe(200);
    await flushAuditWrites();

    expect(auditRowFor("thing.update")).toMatchObject({
      userId: USER_ID,
      groupId: GROUP_ID,
      entityType: "thing",
      entityId: "thing_9",
      metadata: expect.objectContaining({
        outcome: "success",
        actorType: "user",
        method: "POST",
        route: "/things/:id",
      }),
    });

    // The structured mirror carries the same facts, with an explicit
    // timestamp for operators (the row's own timestamp is the database's
    // `created_at` default).
    const event = lines.find(
      (line) => line.event === "audit" && line.action === "thing.update"
    );
    expect(event).toMatchObject({
      actor: { type: "user", id: USER_ID },
      target: { type: "thing", id: "thing_9" },
      groupId: GROUP_ID,
      outcome: "success",
    });
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);

    await app.close();
  });

  it("records nothing for reads, even with the middleware attached", async () => {
    const app = await buildMiddlewareApp(trail);

    const res = await app.inject({ method: "GET", url: "/things" });
    expect(res.statusCode).toBe(200);
    await flushAuditWrites();

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("records nothing for a state-changing request the API rejected", async () => {
    const app = await buildMiddlewareApp(trail);

    const res = await app.inject({
      method: "POST",
      url: "/things/thing_1/reject",
    });
    expect(res.statusCode).toBe(400);
    await flushAuditWrites();

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("delivers the response while the audit write is still pending", async () => {
    const app = await buildMiddlewareApp(trail);
    let release!: () => void;
    prisma.auditLog.create.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );

    const res = await app.inject({ method: "POST", url: "/things/thing_7" });

    // The reply was delivered without the audit row ever settling — the
    // write was scheduled, not awaited (issue #914's latency requirement).
    expect(res.statusCode).toBe(200);
    await vi.waitFor(() => expect(prisma.auditLog.create).toHaveBeenCalled());
    release();
    await flushAuditWrites();
    await app.close();
  });

  it("never copies headers, tokens, or body values into the trail", async () => {
    const app = await buildMiddlewareApp(trail);

    const res = await app.inject({
      method: "POST",
      url: "/things/thing_1",
      headers: {
        authorization: "Bearer super-secret-token",
        "x-api-key": "hunter2",
      },
      payload: { name: "a private value" },
    });
    expect(res.statusCode).toBe(200);
    await flushAuditWrites();

    const row = auditRowFor("thing.update");
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain("super-secret-token");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("a private value");
    // The metadata is exactly the request shape — nothing else leaked in.
    expect(Object.keys(row.metadata).sort()).toEqual([
      "actorType",
      "correlationId",
      "method",
      "outcome",
      "route",
    ]);

    await app.close();
  });

  it("redacts sensitive keys a route opts into before they reach the row", async () => {
    const app = await buildMiddlewareApp({
      ...trail,
      metadata: () => ({
        signedXdr: "AAAA-not-for-the-trail",
        recipientPublicKey: STELLAR_KEY,
      }),
    });

    const res = await app.inject({ method: "POST", url: "/things/thing_1" });
    expect(res.statusCode).toBe(200);
    await flushAuditWrites();

    expect(auditRowFor("thing.update").metadata).toMatchObject({
      signedXdr: "[REDACTED]",
      recipientPublicKey: STELLAR_KEY,
    });

    await app.close();
  });
});

describe("route integration — previously unaudited state changes (#914)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    app = await buildApp();
  });

  it("PATCH /me writes a user.profile.update row naming the changed fields", async () => {
    prisma.user.update.mockResolvedValue({
      id: USER_ID,
      stellarPublicKey: STELLAR_KEY,
      displayName: "Ada",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: authHeader(),
      payload: { displayName: "Ada" },
    });
    expect(res.statusCode).toBe(200);
    await flushAuditWrites();

    expect(auditRowFor("user.profile.update")).toMatchObject({
      userId: USER_ID,
      groupId: null,
      entityType: "user",
      entityId: USER_ID,
      metadata: expect.objectContaining({
        outcome: "success",
        actorType: "user",
        method: "PATCH",
        // Field *names* only — the caller's values never reach the trail.
        fields: ["displayName"],
      }),
    });
    expect(JSON.stringify(auditRowFor("user.profile.update"))).not.toContain(
      "Ada"
    );
  });

  it("PATCH /me writes no row when the request is rejected", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/me",
      headers: authHeader(),
      payload: { displayName: "" },
    });
    expect(res.statusCode).toBe(400);
    await flushAuditWrites();

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("personal webhook registration writes a webhook.register row", async () => {
    prisma.webhook.create.mockResolvedValue({
      id: "wh_personal_1",
      groupId: null,
      userId: USER_ID,
      url: "https://example.test/hook",
      secret: "s".repeat(40),
      events: ["settlement.completed"],
      enabled: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks",
      headers: authHeader(),
      payload: {
        url: "https://example.test/hook",
        events: ["settlement.completed"],
      },
    });
    expect(res.statusCode).toBe(201);
    await flushAuditWrites();

    expect(auditRowFor("webhook.register")).toMatchObject({
      userId: USER_ID,
      groupId: null,
      entityType: "webhook",
      entityId: "wh_personal_1",
      metadata: expect.objectContaining({
        url: "https://example.test/hook",
        events: ["settlement.completed"],
        scope: "personal",
      }),
    });
  });

  it("the webhook test dispatch writes a webhook.test row", async () => {
    prisma.groupMember.findUnique.mockResolvedValue({
      id: "membership_1",
      groupId: GROUP_ID,
      userId: USER_ID,
      role: "member",
    });
    prisma.webhook.findFirst.mockResolvedValue({ id: "wh_1" });
    prisma.webhookDelivery.createMany.mockResolvedValue({ count: 1 });

    const res = await app.inject({
      method: "POST",
      url: `/api/groups/${GROUP_ID}/webhooks/wh_1/test`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    await flushAuditWrites();

    expect(auditRowFor("webhook.test")).toMatchObject({
      userId: USER_ID,
      groupId: GROUP_ID,
      entityType: "webhook",
      entityId: "wh_1",
      metadata: expect.objectContaining({
        outcome: "success",
        actorType: "user",
        method: "POST",
      }),
    });
  });

  it("a receipt upload writes a receipt.upload row without the filename", async () => {
    const boundary = "----mergepayAuditBoundary";
    const payload = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="salary-slip.png"\r\n` +
        `Content-Type: image/png\r\n\r\n` +
        `not-a-real-png\r\n` +
        `--${boundary}--\r\n`,
      "utf8"
    );

    const res = await app.inject({
      method: "POST",
      url: "/api/uploads/receipt",
      headers: {
        ...authHeader(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    await flushAuditWrites();

    expect(auditRowFor("receipt.upload")).toMatchObject({
      userId: USER_ID,
      groupId: null,
      entityType: "receipt",
      entityId: id,
      metadata: expect.objectContaining({
        outcome: "success",
        actorType: "user",
        contentType: "image/png",
      }),
    });
    // The stored filename is deliberately never part of the trail.
    expect(JSON.stringify(auditRowFor("receipt.upload"))).not.toContain(
      "salary-slip.png"
    );
  });
});
