/**
 * Issue #692 — pagination and filtering on the group transaction-history
 * endpoints.
 *
 * The shared cursor helpers are unit-tested in tests/pagination-contract.test.ts;
 * what these cases pin is route-level, because that is where the load actually
 * lands:
 *
 *  1. **The reads are bounded.** Two of these endpoints answered with an
 *     unbounded `findMany` — the webhook delivery list in particular grows by
 *     one row per event per endpoint per retry, so the first request a busy
 *     group made after a quiet week was the one that noticed. Every query here
 *     must carry a `take` and a deterministic `orderBy`.
 *  2. **Filters reach the query, not the page.** A filter applied after the
 *     rows are fetched would shrink pages below the requested limit and make
 *     `hasMore` describe the unfiltered scan. Each case asserts the shape
 *     handed to Prisma.
 *  3. **Boundaries behave.** Empty results, a full last page, and the page
 *     before it return the documented `meta` rather than an error or a
 *     silently truncated body.
 *
 * Prisma is mocked throughout: the subject is the query construction and the
 * response envelope, so no database is touched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    settlement: model(),
    treasuryTransaction: model(),
    webhook: model(),
    webhookDelivery: model(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import { encodeCursor, MAX_PAGE_SIZE } from "../../src/lib/pagination";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../../src/lib/time-bounds";
import {
  expiryCutoff,
  publicStatusFilter,
  settlementFilters,
} from "../../src/services/settlement-history";
import { deliveryFilters } from "../../src/services/webhook-listing";
import { ledgerQuerySchema } from "../../src/services/ledger";

const prisma = h.prisma;
const USER_ID = "user_692";
const GROUP_ID = "group_692";
const WEBHOOK_ID = "wh_692";

let app: Awaited<ReturnType<typeof buildApp>>;

function authHeader(userId = USER_ID) {
  const token = signToken({
    id: userId,
    stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  });
  return { authorization: `Bearer ${token}` };
}

const AT = new Date("2026-05-01T12:00:00.000Z");

/** A user row complete enough for `serializeUser`, which reads `createdAt`. */
const user = (id: string, stellarPublicKey: string) => ({
  id,
  stellarPublicKey,
  displayName: null,
  avatarUrl: null,
  createdAt: AT,
});

const delivery = (over: Record<string, any> = {}) => ({
  id: "delivery_1",
  webhookId: WEBHOOK_ID,
  eventType: "expense.created",
  payload: '{"secret":"the exact signed bytes"}',
  status: "failed",
  attempts: 3,
  responseStatusCode: 500,
  responseBody: "upstream said something private",
  nextAttemptAt: null,
  lastAttemptAt: AT,
  claimedBy: null,
  leaseExpiresAt: null,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const webhookRow = (over: Record<string, any> = {}) => ({
  id: WEBHOOK_ID,
  groupId: GROUP_ID,
  userId: null,
  url: "https://example.test/hook",
  secret: "never-returned-on-a-list",
  events: ["expense.created"],
  enabled: true,
  createdAt: AT,
  updatedAt: AT,
  ...over,
});

const settlementRow = (over: Record<string, any> = {}) => ({
  id: "settlement_1",
  shortCode: "ABC234",
  groupId: GROUP_ID,
  fromUserId: USER_ID,
  toUserId: "user_other",
  amount: "10.0000000",
  assetCode: "USDC",
  assetIssuer: null,
  stellarTxHash: null,
  transactionXdr: null,
  status: "pending",
  expiresAt: null,
  createdAt: AT,
  updatedAt: AT,
  retryCount: 0,
  from: user(USER_ID, "GA"),
  to: user("user_other", "GB"),
  ...over,
});

const expenseRow = (over: Record<string, any> = {}) => ({
  id: "expense_1",
  groupId: GROUP_ID,
  payerUserId: USER_ID,
  title: "Dinner",
  description: null,
  amount: "10.0000000",
  assetCode: "XLM",
  assetIssuer: null,
  splitType: "equal",
  memo: "ABC234",
  receiptUrl: null,
  createdAt: AT,
  updatedAt: AT,
  payer: user(USER_ID, "GA"),
  shares: [],
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp({ rateLimit: "off" });

  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "admin",
  });
  prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID, archived: false });
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID });
  prisma.webhook.findFirst.mockResolvedValue({ id: WEBHOOK_ID });
  prisma.webhook.findMany.mockResolvedValue([]);
  prisma.webhookDelivery.findMany.mockResolvedValue([]);
  prisma.settlement.findMany.mockResolvedValue([]);
  prisma.expense.findMany.mockResolvedValue([]);
  prisma.treasuryTransaction.findMany.mockResolvedValue([]);
});

describe("GET /groups/:groupId/webhooks/:webhookId/deliveries — pagination", () => {
  const url = `/groups/${GROUP_ID}/webhooks/${WEBHOOK_ID}/deliveries`;

  it("bounds the read and returns standardized page metadata", async () => {
    prisma.webhookDelivery.findMany.mockResolvedValue([delivery()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toMatchObject({
      hasMore: false,
      nextCursor: null,
      order: "desc",
      limit: 50,
    });

    const args = prisma.webhookDelivery.findMany.mock.calls[0][0];
    expect(args.take).toBeGreaterThan(0);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.where.webhookId).toBe(WEBHOOK_ID);
  });

  it("returns a next cursor when a further page exists", async () => {
    // limit + 1 rows: the lookahead row is what makes hasMore exact without a
    // second count query.
    const rows = Array.from({ length: 3 }, (_, i) =>
      delivery({ id: `delivery_${i}`, createdAt: new Date(2026, 4, 1, 12, 0, i) })
    );
    prisma.webhookDelivery.findMany.mockResolvedValue(rows);

    const res = await app.inject({
      method: "GET",
      url: `${url}?limit=2`,
      headers: authHeader(),
    });

    const body = res.json();
    expect(body.deliveries).toHaveLength(2);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toEqual(expect.any(String));
  });

  it("reports the last page as the last page", async () => {
    // Exactly `limit` rows and no lookahead: there is nothing after this.
    const rows = Array.from({ length: 2 }, (_, i) =>
      delivery({ id: `delivery_${i}`, createdAt: new Date(2026, 4, 1, 12, 0, i) })
    );
    prisma.webhookDelivery.findMany.mockResolvedValue(rows);

    const body = (
      await app.inject({ method: "GET", url: `${url}?limit=2`, headers: authHeader() })
    ).json();

    expect(body.deliveries).toHaveLength(2);
    expect(body.meta).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("returns an empty page rather than an error when there are no deliveries", async () => {
    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().deliveries).toEqual([]);
    expect(res.json().meta).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("resumes strictly after the cursor position", async () => {
    const cursor = encodeCursor(AT, "delivery_1");

    await app.inject({
      method: "GET",
      url: `${url}?cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.webhookDelivery.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { createdAt: { lt: AT } },
      { createdAt: AT, id: { lt: "delivery_1" } },
    ]);
  });

  it("rejects a malformed cursor rather than silently restarting", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?cursor=not-a-real-cursor`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("rejects a page size above the maximum instead of clamping it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?limit=${MAX_PAGE_SIZE + 1}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("never returns the signed payload or the receiver's response body", async () => {
    // Both are on the row. The payload is the group's data re-served through a
    // different authorization path, and the response body is third-party text.
    prisma.webhookDelivery.findMany.mockResolvedValue([delivery()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });
    const [row] = res.json().deliveries;

    expect(row).not.toHaveProperty("payload");
    expect(row).not.toHaveProperty("responseBody");
    expect(res.payload).not.toContain("the exact signed bytes");
    expect(res.payload).not.toContain("something private");
    // The operationally useful fields are still there.
    expect(row).toMatchObject({
      id: "delivery_1",
      eventType: "expense.created",
      status: "failed",
      attempts: 3,
      responseStatusCode: 500,
    });
  });
});

describe("GET /groups/:groupId/webhooks/:webhookId/deliveries — filtering", () => {
  const url = `/groups/${GROUP_ID}/webhooks/${WEBHOOK_ID}/deliveries`;

  it("filters by delivery status in the query", async () => {
    await app.inject({ method: "GET", url: `${url}?status=failed`, headers: authHeader() });

    const args = prisma.webhookDelivery.findMany.mock.calls[0][0];
    expect(args.where.AND).toEqual(
      expect.arrayContaining([{ webhookId: WEBHOOK_ID }, { status: "failed" }])
    );
  });

  it("filters by event type in the query", async () => {
    await app.inject({
      method: "GET",
      url: `${url}?event=expense.created`,
      headers: authHeader(),
    });

    const args = prisma.webhookDelivery.findMany.mock.calls[0][0];
    expect(args.where.AND).toEqual(
      expect.arrayContaining([{ eventType: "expense.created" }])
    );
  });

  it("composes a filter with the cursor instead of replacing it", async () => {
    const cursor = encodeCursor(AT, "delivery_1");

    await app.inject({
      method: "GET",
      url: `${url}?status=failed&cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.webhookDelivery.findMany.mock.calls[0][0];
    expect(args.where.AND).toHaveLength(3);
    expect(args.where.AND[2].OR).toEqual([
      { createdAt: { lt: AT } },
      { createdAt: AT, id: { lt: "delivery_1" } },
    ]);
  });

  it("rejects an unknown status or event rather than returning an empty page", async () => {
    for (const query of ["status=exploded", "event=expense.invented"]) {
      const res = await app.inject({
        method: "GET",
        url: `${url}?${query}`,
        headers: authHeader(),
      });
      expect(res.statusCode, query).toBe(400);
    }
    expect(prisma.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it("keeps the endpoint scope out of the cursor's reach", () => {
    // The webhook id is always a filter of its own, so a cursor lifted from
    // another endpoint's list can only move where a page starts inside data
    // the caller may already read.
    expect(deliveryFilters(WEBHOOK_ID, {})).toEqual([{ webhookId: WEBHOOK_ID }]);
    expect(deliveryFilters(WEBHOOK_ID, { status: "delivered" })).toEqual([
      { webhookId: WEBHOOK_ID },
      { status: "delivered" },
    ]);
  });
});

describe("GET /groups/:groupId/webhooks — pagination", () => {
  const url = `/groups/${GROUP_ID}/webhooks`;

  it("bounds the read and returns page metadata", async () => {
    prisma.webhook.findMany.mockResolvedValue([webhookRow()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toMatchObject({ hasMore: false, nextCursor: null });

    const args = prisma.webhook.findMany.mock.calls[0][0];
    expect(args.take).toBeGreaterThan(0);
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.where.groupId).toBe(GROUP_ID);
  });

  it("still never returns an endpoint's signing secret", async () => {
    prisma.webhook.findMany.mockResolvedValue([webhookRow()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.payload).not.toContain("never-returned-on-a-list");
    expect(res.json().webhooks[0]).not.toHaveProperty("secret");
  });

  it("returns an empty page when the group has no endpoints", async () => {
    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().webhooks).toEqual([]);
  });
});

describe("GET /groups/:id/settlements — filtering", () => {
  const url = `/groups/${GROUP_ID}/settlements`;

  it("keeps the unfiltered query exactly as it was", async () => {
    prisma.settlement.findMany.mockResolvedValue([settlementRow()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    const args = prisma.settlement.findMany.mock.calls[0][0];
    // Flat shape, no AND wrapper: an unfiltered request pays nothing for the
    // filters existing.
    expect(args.where).toEqual({ groupId: GROUP_ID });
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("filters by asset in the query", async () => {
    await app.inject({ method: "GET", url: `${url}?asset=USDC`, headers: authHeader() });

    const args = prisma.settlement.findMany.mock.calls[0][0];
    expect(args.where.AND).toEqual(
      expect.arrayContaining([{ groupId: GROUP_ID }, { assetCode: "USDC" }])
    );
  });

  it("filters by an inclusive date range", async () => {
    await app.inject({
      method: "GET",
      url: `${url}?startDate=2026-05-01T00:00:00.000Z&endDate=2026-05-31T23:59:59.000Z`,
      headers: authHeader(),
    });

    const args = prisma.settlement.findMany.mock.calls[0][0];
    expect(args.where.AND).toEqual(
      expect.arrayContaining([
        {
          createdAt: {
            gte: new Date("2026-05-01T00:00:00.000Z"),
            lte: new Date("2026-05-31T23:59:59.000Z"),
          },
        },
      ])
    );
  });

  it("rejects a reversed date range instead of returning nothing", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?startDate=2026-06-01T00:00:00.000Z&endDate=2026-05-01T00:00:00.000Z`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_RANGE");
    expect(prisma.settlement.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown status rather than returning an empty page", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?status=almost_done`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.settlement.findMany).not.toHaveBeenCalled();
  });

  it("counts the filtered set only when the caller asks for a total", async () => {
    prisma.settlement.count.mockResolvedValue(42);

    const without = await app.inject({
      method: "GET",
      url: `${url}?asset=USDC`,
      headers: authHeader(),
    });
    expect(without.json().meta.total).toBeUndefined();
    expect(prisma.settlement.count).not.toHaveBeenCalled();

    const withTotal = await app.inject({
      method: "GET",
      url: `${url}?asset=USDC&includeTotal=true`,
      headers: authHeader(),
    });
    expect(withTotal.json().meta.total).toBe(42);

    // Counted over the filters alone: including the cursor would count only
    // the remainder of the scan.
    const countArgs = prisma.settlement.count.mock.calls[0][0];
    expect(countArgs.where.AND).toEqual([{ groupId: GROUP_ID }, { assetCode: "USDC" }]);
  });

  it("composes filters with the cursor", async () => {
    const cursor = encodeCursor(AT, "settlement_1");

    await app.inject({
      method: "GET",
      url: `${url}?asset=USDC&cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.settlement.findMany.mock.calls[0][0];
    expect(args.where.AND[args.where.AND.length - 1].OR).toEqual([
      { createdAt: { lt: AT } },
      { createdAt: AT, id: { lt: "settlement_1" } },
    ]);
  });
});

/**
 * The public status filter is the inverse of `toPublicStatus`, so it gets its
 * own cases: a filter that disagreed with the status a settlement reports when
 * read individually would be worse than no filter at all.
 */
describe("settlement status filtering is the inverse of the public status", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");
  const cutoff = expiryCutoff(now);

  it("derives the cutoff with the same clock-skew tolerance as the expiry check", () => {
    expect(cutoff.getTime()).toBe(now.getTime() - CLOCK_SKEW_TOLERANCE_SECONDS * 1000);
  });

  it("matches a stored terminal status directly, whatever the clock reads", () => {
    expect(publicStatusFilter("confirmed", now)).toEqual({ status: "confirmed" });
    expect(publicStatusFilter("failed", now)).toEqual({ status: "failed" });
  });

  it("treats a lapsed in-flight row as expired, not as still in flight", () => {
    const filter = publicStatusFilter("expired", now) as any;
    expect(filter.OR[0]).toEqual({ status: "expired" });
    expect(filter.OR[1]).toEqual({
      status: { notIn: ["confirmed", "failed", "expired"] },
      expiresAt: { lt: cutoff },
    });
  });

  it("requires a live window for submitted and awaiting_signature", () => {
    const live = { OR: [{ expiresAt: null }, { expiresAt: { gte: cutoff } }] };
    expect(publicStatusFilter("submitted", now)).toEqual({
      AND: [{ status: "submitted" }, live],
    });
    expect(publicStatusFilter("awaiting_signature", now)).toEqual({
      AND: [
        { status: { notIn: ["confirmed", "failed", "expired", "submitted"] } },
        live,
      ],
    });
  });

  it("puts an unrecognised column value in awaiting_signature, as the mapping does", () => {
    // `toPublicStatus` reports anything it does not know as awaiting_signature,
    // so the filter is written with `notIn` rather than `equals: "pending"` —
    // otherwise a row with a future status value would be unreachable through
    // every one of the five filters.
    const filter = publicStatusFilter("awaiting_signature", now) as any;
    expect(filter.AND[0].status.notIn).not.toContain("pending");
  });

  it("scopes by group independently of any status filter", () => {
    expect(settlementFilters(GROUP_ID, {}, now)).toEqual([{ groupId: GROUP_ID }]);
    expect(settlementFilters(GROUP_ID, { status: "confirmed" }, now)[0]).toEqual({
      groupId: GROUP_ID,
    });
  });
});

describe("GET /groups/:id/ledger — filtering", () => {
  const url = `/groups/${GROUP_ID}/ledger`;

  it("reads all three tables when no type is named", async () => {
    await app.inject({ method: "GET", url, headers: authHeader() });

    expect(prisma.expense.findMany).toHaveBeenCalled();
    expect(prisma.settlement.findMany).toHaveBeenCalled();
    expect(prisma.treasuryTransaction.findMany).toHaveBeenCalled();
  });

  it("reads only the requested table for a single type", async () => {
    await app.inject({ method: "GET", url: `${url}?type=expense`, headers: authHeader() });

    expect(prisma.expense.findMany).toHaveBeenCalled();
    expect(prisma.settlement.findMany).not.toHaveBeenCalled();
    expect(prisma.treasuryTransaction.findMany).not.toHaveBeenCalled();
  });

  it("accepts a comma-separated list of types", async () => {
    await app.inject({
      method: "GET",
      url: `${url}?type=expense,treasury`,
      headers: authHeader(),
    });

    expect(prisma.expense.findMany).toHaveBeenCalled();
    expect(prisma.treasuryTransaction.findMany).toHaveBeenCalled();
    expect(prisma.settlement.findMany).not.toHaveBeenCalled();
  });

  it("returns only entries of the requested type", async () => {
    prisma.expense.findMany.mockResolvedValue([expenseRow()]);

    const body = (
      await app.inject({ method: "GET", url: `${url}?type=expense`, headers: authHeader() })
    ).json();

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].type).toBe("expense");
    expect(body.meta).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("pushes the date bound into every table it reads", async () => {
    await app.inject({
      method: "GET",
      url: `${url}?startDate=2026-05-01T00:00:00.000Z`,
      headers: authHeader(),
    });

    for (const model of [
      prisma.expense.findMany,
      prisma.settlement.findMany,
      prisma.treasuryTransaction.findMany,
    ]) {
      const args = model.mock.calls[0][0];
      expect(args.where.createdAt).toEqual({
        gte: new Date("2026-05-01T00:00:00.000Z"),
      });
      // The bound is a filter alongside the cursor, so each table is still
      // read with its own bounded window.
      expect(args.take).toBeGreaterThan(0);
    }
  });

  it("keeps the unfiltered query exactly as it was", async () => {
    await app.inject({ method: "GET", url, headers: authHeader() });

    const args = prisma.expense.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ groupId: GROUP_ID });
  });

  it("rejects an unknown type rather than returning an empty ledger", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?type=invoice`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("rejects a reversed date range", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?startDate=2026-06-01T00:00:00.000Z&endDate=2026-05-01T00:00:00.000Z`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.expense.findMany).not.toHaveBeenCalled();
  });

  it("de-duplicates a repeated type so no table is read twice", () => {
    expect(ledgerQuerySchema.parse({ type: "expense,expense" }).type).toEqual(["expense"]);
    expect(ledgerQuerySchema.parse({ type: " expense , settlement " }).type).toEqual([
      "expense",
      "settlement",
    ]);
    expect(ledgerQuerySchema.parse({}).type).toBeUndefined();
  });
});
