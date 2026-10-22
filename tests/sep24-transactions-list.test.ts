/**
 * Route-level tests for SEP-24 transaction list polling (#655).
 *
 * Covers `GET /api/sep24/transactions` — the endpoint a wallet uses to find out
 * which of its deposits and withdrawals to poll — and the contract that makes
 * it worth having: every item it returns is the *same* SEP-24 transaction
 * object `GET /api/sep24/transaction` returns for that transaction, paged by
 * the API's shared cursor convention, and scoped to the caller.
 *
 * Prisma is mocked, so no database is touched and the anchor is never called:
 * the session row is the source of truth, kept current by the worker.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: { findFirst: vi.fn(), findMany: vi.fn() },
    statusHistory: { findMany: vi.fn() },
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

// The anchor client, spied rather than silenced: the point of these routes is
// that polling them never reaches the anchor, and only a spy on the real
// service can say that. Everything else about the module stays as written, so
// the routes that import it still load.
const anchor = vi.hoisted(() => ({
  getToml: vi.fn(),
  getChallenge: vi.fn(),
  getToken: vi.fn(),
  startInteractive: vi.fn(),
}));

vi.mock("../src/services/anchor", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    anchorService: { ...(actual as any).anchorService, ...anchor },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

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
    createdAt: T1,
    updatedAt: T2,
    ...over,
  };
}

/** Newest-first, as `getStatusHistory` returns it. */
function historyRows(entityId = "session_1") {
  return [
    {
      id: "sh_2",
      entityType: "anchor_session",
      entityId,
      status: "pending_user_transfer_start",
      reason: "Send your deposit now",
      source: "worker",
      createdAt: T2,
    },
    {
      id: "sh_1",
      entityType: "anchor_session",
      entityId,
      status: "incomplete",
      reason: "Session created",
      source: "user",
      createdAt: T1,
    },
  ];
}

function list(query = "", userId = "user_1") {
  return app.inject({
    method: "GET",
    url: `/api/sep24/transactions${query ? `?${query}` : ""}`,
    headers: authHeader(userId),
  });
}

/** The same transaction read through the single-transaction poll. */
function single(id: string) {
  return app.inject({
    method: "GET",
    url: `/api/sep24/transaction?id=${id}`,
    headers: authHeader(),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  prisma.statusHistory.findMany.mockResolvedValue([]);
  if (!app) app = await buildApp();
});

describe("GET /api/sep24/transactions — the list envelope", () => {
  it("returns the caller's transactions in the spec's envelope, with a real timeline", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([sessionRow()]);
    prisma.statusHistory.findMany.mockResolvedValue(historyRows());

    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      transactions: [
        {
          id: "ext_1",
          kind: "deposit",
          status: "pending_user_transfer_start",
          session_id: "session_1",
          started_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-03T00:00:00.000Z",
          message: "Send your deposit now",
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
              source: "worker",
              reason: "Send your deposit now",
            },
          ],
        },
      ],
      meta: { nextCursor: null, hasMore: false, limit: 50, order: "desc" },
    });
  });

  it("answers a list item with exactly what the single-transaction poll answers", async () => {
    const row = sessionRow({ interactiveUrl: "https://anchor.example/sep24?j=1" });
    prisma.anchorSession.findMany.mockResolvedValue([row]);
    prisma.anchorSession.findFirst.mockResolvedValue(row);
    prisma.statusHistory.findMany.mockResolvedValue(historyRows());

    const listed = (await list()).json().transactions[0];
    const polled = (await single("ext_1")).json();

    // The two routes describe one transaction, so they cannot disagree about
    // it: a client that pages through the list and then polls an id must read
    // the same object. This fails if either route gains a field the other does
    // not declare.
    expect(listed).toEqual(polled);
  });

  it("returns an empty list without inventing a transaction", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list();

    expect(res.json()).toEqual({
      transactions: [],
      meta: { nextCursor: null, hasMore: false, limit: 50, order: "desc" },
    });
    // No rows means no timelines to read; a call per page would be a claim of
    // its own.
    expect(prisma.statusHistory.findMany).not.toHaveBeenCalled();
  });

  it("reads each transaction's own timeline, capped the way the single poll caps it", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([
      sessionRow({ id: "session_a", externalTransactionId: "ext_a" }),
      sessionRow({ id: "session_b", externalTransactionId: "ext_b" }),
    ]);

    const res = await list();

    expect(res.statusCode).toBe(200);
    expect(prisma.statusHistory.findMany.mock.calls.map((c: any) => c[0].where)).toEqual([
      { entityType: "anchor_session", entityId: "session_a" },
      { entityType: "anchor_session", entityId: "session_b" },
    ]);
    // The 50-row bound `getStatusHistory` applies to a single poll applies to
    // every row of a page too, so one long-lived transaction cannot make the
    // page unbounded.
    for (const call of prisma.statusHistory.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ orderBy: { createdAt: "desc" }, take: 50 });
    }
  });

  it("answers from the database and never contacts the anchor", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([sessionRow()]);

    const res = await list();

    expect(res.statusCode).toBe(200);
    // Polling in a loop is the expected use of this endpoint; amplifying it
    // into anchor traffic is the failure the single poll documents too.
    expect(anchor.getToml).not.toHaveBeenCalled();
    expect(anchor.getChallenge).not.toHaveBeenCalled();
    expect(anchor.startInteractive).not.toHaveBeenCalled();
    expect(prisma.anchorSession.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/sep24/transactions — pagination", () => {
  it("fetches one row past the page and returns a cursor only when more remains", async () => {
    const rows = [
      sessionRow({ id: "s3", createdAt: T2 }),
      sessionRow({ id: "s2", createdAt: T1 }),
      sessionRow({ id: "s1", createdAt: T0 }),
    ];
    // limit=2 asks for 2, so the third row is the lookahead that proves there
    // is another page.
    prisma.anchorSession.findMany.mockResolvedValue(rows);

    const res = await list("limit=2");
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.findMany.mock.calls[0][0]).toMatchObject({ take: 3 });
    expect(body.transactions.map((t: any) => t.session_id)).toEqual(["s3", "s2"]);
    expect(body.meta).toEqual({
      nextCursor: Buffer.from(`${T1.getTime()}_s2`).toString("base64url"),
      hasMore: true,
      limit: 2,
      order: "desc",
    });
  });

  it("resumes strictly after the cursor on the deterministic (createdAt, id) pair", async () => {
    const cursor = Buffer.from(`${T1.getTime()}_s2`).toString("base64url");
    prisma.anchorSession.findMany.mockResolvedValue([sessionRow({ id: "s1", createdAt: T0 })]);

    const res = await list(`cursor=${cursor}`);

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        userId: "user_1",
        OR: [
          { createdAt: { lt: T1 } },
          { createdAt: T1, id: { lt: "s2" } },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("flips both comparators for an ascending page", async () => {
    const cursor = Buffer.from(`${T1.getTime()}_s2`).toString("base64url");
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list(`cursor=${cursor}&order=asc`);

    expect(res.statusCode).toBe(200);
    const { where, orderBy } = prisma.anchorSession.findMany.mock.calls[0][0];
    expect(orderBy).toEqual([{ createdAt: "asc" }, { id: "asc" }]);
    expect(where.OR).toEqual([
      { createdAt: { gt: T1 } },
      { createdAt: T1, id: { gt: "s2" } },
    ]);
  });

  it.each([
    ["limit=0", "below the minimum"],
    ["limit=101", "above the ceiling"],
    ["limit=abc", "not an integer"],
    ["limit=1.5", "not a whole page"],
  ])("400s on %s (%s)", async (query) => {
    const res = await list(query);

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(res.json().error.issues).toBeTruthy();
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a malformed cursor instead of restarting from page one", async () => {
    const res = await list("cursor=not-a-cursor");

    // Ignoring garbage would hand back the newest page to a client that
    // believed it was paging on.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects a page-based parameter rather than silently honouring the default page", async () => {
    const res = await list("page=2");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("rejects an offset key the endpoint does not implement", async () => {
    const res = await list("offset=50");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });
});

describe("GET /api/sep24/transactions — kind filter", () => {
  it("filters withdrawals by the stored direction", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list("kind=withdrawal");

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.findMany.mock.calls[0][0].where.kind).toBe("withdrawal");
  });

  it("filters deposits as everything that is not a withdrawal", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list("kind=deposit");

    expect(res.statusCode).toBe(200);
    // `toSep24Kind` renders any stored value other than "withdrawal" as a
    // deposit, so the filter has to match the same rows or a transaction shown
    // as a deposit in the unfiltered list vanishes when deposits are asked for.
    expect(prisma.anchorSession.findMany.mock.calls[0][0].where.kind).toEqual({
      not: "withdrawal",
    });
  });

  it.each(["kind=depos", "kind=DEPOSIT", "kind=payment", "kind="])(
    "400s on %s instead of answering with an empty list",
    async (query) => {
      const res = await list(query);

      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("VALIDATION_ERROR");
      expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
    }
  );

  it("combines the kind filter with the caller scope and the cursor", async () => {
    const cursor = Buffer.from(`${T1.getTime()}_s2`).toString("base64url");
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list(`kind=withdrawal&cursor=${cursor}&limit=5`);

    expect(res.statusCode).toBe(200);
    const { where, take } = prisma.anchorSession.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ userId: "user_1", kind: "withdrawal" });
    expect(where.OR).toBeTruthy();
    expect(take).toBe(6);
  });
});

describe("GET /api/sep24/transactions — authentication and scope", () => {
  it("rejects an unauthenticated poll before touching the database", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sep24/transactions" });

    expect(res.statusCode).toBe(401);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("scopes every query to the caller and takes no identity from the query string", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list("", "user_77");

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.findMany.mock.calls[0][0].where.userId).toBe("user_77");
  });

  it("cannot be asked for another user's transactions", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list("userId=user_2&kind=deposit");

    // There is no such parameter, so the strict schema rejects it — the answer
    // is not a silently-scoped page that looks like it worked.
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });

  it("carries no scope in the cursor: replaying another caller's cursor only moves where the page starts", async () => {
    // A cursor lifted from user_1's response, replayed by user_2.
    const cursor = Buffer.from(`${T1.getTime()}_s2`).toString("base64url");
    prisma.anchorSession.findMany.mockResolvedValue([]);

    const res = await list(`cursor=${cursor}`, "user_2");

    expect(res.statusCode).toBe(200);
    const { where } = prisma.anchorSession.findMany.mock.calls[0][0];
    expect(where.userId).toBe("user_2");
    expect(where.OR).toBeTruthy();
  });

  it("accepts the spec's lang parameter and ignores it", async () => {
    prisma.anchorSession.findMany.mockResolvedValue([sessionRow()]);

    const res = await list("lang=fr");

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.findMany.mock.calls[0][0].where).not.toHaveProperty("lang");
  });
});
