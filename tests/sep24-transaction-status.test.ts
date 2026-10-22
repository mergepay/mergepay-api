/**
 * Route-level tests for SEP-24 transaction status tracking (#651).
 *
 * Covers `GET /api/sep24/transaction` — the endpoint a client polls for one
 * deposit or withdrawal — and the two writes that make its timeline real: the
 * anchor callback recording the anchor's own message on the transition's
 * `status_history` row, and `GET /anchors/sessions/:id` reading the rows back.
 *
 * Prisma is mocked, so no database is touched; the anchor is never called,
 * because the session row is the source of truth (src/worker polls it).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    withdrawal: {
      findUnique: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn() },
    statusHistory: { create: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";

const prisma = h.prisma;

let app: Awaited<ReturnType<typeof buildApp>>;

const T0 = new Date("2026-01-01T00:00:00.000Z");
const T1 = new Date("2026-01-02T00:00:00.000Z");
const T2 = new Date("2026-01-03T00:00:00.000Z");

function authHeader(userId = "user_1") {
  const token = signToken({
    id: userId,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

function sessionRow(over: Record<string, any> = {}) {
  return {
    id: "session_1",
    userId: "user_1",
    anchorName: "Test Anchor",
    kind: "deposit",
    assetCode: "USDC",
    interactiveUrl: null,
    externalTransactionId: "ext_1",
    anchorToken: null,
    status: "pending_user_transfer_start",
    failureReason: null,
    createdAt: T0,
    updatedAt: T1,
    ...over,
  };
}

/** `status_history` rows as getStatusHistory returns them: newest first. */
function historyRows() {
  return [
    {
      id: "sh_3",
      entityType: "anchor_session",
      entityId: "session_1",
      status: "pending_user_transfer_start",
      reason: "Share your account number with the anchor",
      source: "user",
      createdAt: T2,
    },
    {
      id: "sh_2",
      entityType: "anchor_session",
      entityId: "session_1",
      status: "incomplete",
      reason: "Session created",
      source: "user",
      createdAt: T1,
    },
  ];
}

function get(query = "id=ext_1", headers = authHeader()) {
  return app.inject({ method: "GET", url: `/api/sep24/transaction?${query}`, headers });
}

beforeEach(async () => {
  vi.clearAllMocks();
  prisma.statusHistory.findMany.mockResolvedValue(historyRows());
  if (!app) app = await buildApp();
});

describe("GET /api/sep24/transaction — the SEP-24 response", () => {
  it("returns the transaction object with its timeline, oldest first", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(sessionRow());

    const res = await get();
    expect(res.statusCode).toBe(200);

    // The spec's own field set: a client polling this route gets a SEP-24
    // transaction, not Mergepay's session envelope.
    expect(res.json()).toEqual({
      id: "ext_1",
      kind: "deposit",
      status: "pending_user_transfer_start",
      session_id: "session_1",
      started_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-02T00:00:00.000Z",
      message: "Share your account number with the anchor",
      status_history: [
        {
          status: "incomplete",
          at: "2026-01-02T00:00:00.000Z",
          source: "user",
          reason: "Session created",
        },
        {
          status: "pending_user_transfer_start",
          at: "2026-01-03T00:00:00.000Z",
          source: "user",
          reason: "Share your account number with the anchor",
        },
      ],
    });
  });

  it("answers from the stored session without contacting the anchor", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(sessionRow());

    await get();

    // A client polling in a loop must not be able to amplify into the anchor;
    // the worker keeps this row current.
    expect(prisma.anchorSession.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.statusHistory.findMany).toHaveBeenCalledTimes(1);
  });

  it("looks the transaction up by either identifier, scoped to the caller", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(sessionRow());

    await get("id=session_1");

    expect(prisma.anchorSession.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        OR: [{ id: "session_1" }, { externalTransactionId: "session_1" }],
      },
    });
  });

  it("omits the fields Mergepay cannot answer, and never fakes them", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(
      sessionRow({ interactiveUrl: null, updatedAt: null, failureReason: null })
    );
    prisma.statusHistory.findMany.mockResolvedValue([]);

    const body = (await get()).json();

    expect(body).not.toHaveProperty("more_info_url");
    expect(body).not.toHaveProperty("updated_at");
    expect(body).not.toHaveProperty("completed_at");
    expect(body).not.toHaveProperty("message");
    expect(body.status_history).toEqual([]);
  });

  it("exposes the interactive URL as more_info_url once the flow has one", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(
      sessionRow({ interactiveUrl: "https://anchor.example/sep24?j=1" })
    );

    expect((await get()).json().more_info_url).toBe("https://anchor.example/sep24?j=1");
  });

  it("stamps completed_at once the session is terminal", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(sessionRow({ status: "completed" }));

    const body = (await get()).json();

    // The session row has no completion column; the transition into the
    // terminal status is when it completed.
    expect(body.completed_at).toBe("2026-01-03T00:00:00.000Z");
  });

  it("shows the session's own failure reason as the current message", async () => {
    prisma.anchorSession.findFirst.mockResolvedValue(
      sessionRow({ status: "pending_trust", failureReason: "Add a trustline to GBUSD" })
    );

    const body = (await get()).json();

    // failureReason is rewritten by every callback including one that changes
    // no status, so it can describe the status the client is looking at.
    expect(body.message).toBe("Add a trustline to GBUSD");
  });
});

describe("GET /api/sep24/transaction — authentication and validation", () => {
  it("rejects an unauthenticated poll before touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sep24/transaction?id=ext_1" });

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findFirst).not.toHaveBeenCalled();
  });

  it("404s a transaction the caller does not own rather than confirming it exists", async () => {
    // The lookup is scoped by userId, so another user's id never matches.
    prisma.anchorSession.findFirst.mockResolvedValue(null);

    const res = await get("id=someone_elses_session", authHeader("user_2"));

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe("NOT_FOUND");
    expect(res.json().requestId).toBeTruthy();
    expect(prisma.statusHistory.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ["", "the locator is required"],
    ["id=", "empty is not an id"],
    ["id=" + "x".repeat(121), "an id cannot be unbounded"],
    ["id=aa bb", "whitespace is not an opaque id"],
    ["id=a/b", "a path is not an opaque id"],
    ["id=a%3Fb=c", "a query fragment is not an opaque id"],
  ])("400s on %s (%s)", async (query) => {
    const res = await get(query);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.anchorSession.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter instead of ignoring it", async () => {
    // SEP-24 defines id and lang; a misspelt locator must not silently poll
    // every transaction the caller owns.
    const res = await get("id=ext_1&transaction=ext_1");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.anchorSession.findFirst).not.toHaveBeenCalled();
  });

  it("accepts the anchor's own composite id and a lang", async () => {
    // The reference anchors mint `account:nonce` identifiers.
    prisma.anchorSession.findFirst.mockResolvedValue(
      sessionRow({ externalTransactionId: "GBXY:1712345678" })
    );

    const res = await get("id=GBXY:1712345678&lang=fr");

    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe("GBXY:1712345678");
  });
});

describe("anchor callbacks record the anchor's own words (#651)", () => {
  async function webhook(body: any) {
    return app.inject({
      method: "POST",
      url: "/anchors/webhook",
      headers: { "x-webhook-secret": config.ANCHOR_WEBHOOK_SECRET },
      payload: body,
    });
  }

  it("writes the message onto the transition's history row", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([
      { id: "session_1", status: "pending_trust" },
    ]);
    prisma.anchorSession.findUnique.mockResolvedValue(
      sessionRow({ status: "pending_trust" })
    );
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await webhook({
      transaction: {
        id: "ext_1",
        status: "completed",
        message: "Your deposit landed. Bearer abc123 was used to sign in.",
      },
    });
    expect(res.statusCode).toBe(200);

    // The history row is where each transition's own message belongs: the
    // session column it used to live in is overwritten by the next callback.
    expect(prisma.statusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityType: "anchor_session",
        entityId: "session_1",
        status: "completed",
        source: "webhook",
        reason: expect.stringContaining("Your deposit landed"),
      }),
    });
    const written = prisma.statusHistory.create.mock.calls[0][0].data.reason;
    // Sanitized: the message is untrusted anchor text rendered to clients.
    expect(written).not.toContain("abc123");
    expect(written).toContain("bearer [redacted]");
  });

  it("stores the session's failure reason sanitized too", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([
      { id: "session_1", status: "pending_trust" },
    ]);
    prisma.anchorSession.findUnique.mockResolvedValue(
      sessionRow({ status: "pending_trust" })
    );
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    await webhook({
      transaction: { id: "ext_1", status: "completed", message: "token=hunter2 done" },
    });

    const { data } = prisma.anchorSession.updateMany.mock.calls[0][0];
    expect(data.failureReason).toBe("token=[redacted] done");
  });

  it("records no reason when the anchor sent no message", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([
      { id: "session_1", status: "pending_trust" },
    ]);
    prisma.anchorSession.findUnique.mockResolvedValue(
      sessionRow({ status: "pending_trust" })
    );
    prisma.anchorSession.updateMany.mockResolvedValue({ count: 1 });

    await webhook({ transaction: { id: "ext_1", status: "completed" } });

    expect(prisma.statusHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: "completed", reason: null }),
    });
    expect(prisma.anchorSession.updateMany.mock.calls[0][0].data).not.toHaveProperty(
      "failureReason"
    );
  });
});

describe("GET /anchors/sessions/:id reads its timeline back (#651)", () => {
  it("returns the session's real status history", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(sessionRow());

    const res = await app.inject({
      method: "GET",
      url: "/anchors/sessions/session_1",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.statusHistory.findMany).toHaveBeenCalledWith({
      where: { entityType: "anchor_session", entityId: "session_1" },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    expect(res.json().session.statusHistory.map((r: any) => r.status)).toEqual([
      "pending_user_transfer_start",
      "incomplete",
    ]);
  });

  it("leaves the field out of a list response rather than claiming an empty timeline", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([sessionRow()]);

    const res = await app.inject({
      method: "GET",
      url: "/anchors/sessions",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    // The list never reads status_history, so `statusHistory: []` would be a
    // claim that the transaction never changed status.
    expect(res.json().sessions[0]).not.toHaveProperty("statusHistory");
  });
});
