/**
 * Cursor pagination on the group-scoped list endpoints (issue #205).
 *
 * The shared helpers in src/lib/pagination.ts are unit-tested elsewhere; these
 * tests drive the routes that adopt them, because the properties that matter
 * are route-level: that membership is enforced before any row is read, that a
 * page boundary holds when timestamps tie, and that a malformed cursor is an
 * error rather than a silent reset to page one.
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
    treasuryProposal: model(),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import { MAX_PAGE_SIZE, encodeCursor } from "../../src/lib/pagination";

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

const proposal = (over: Record<string, any> = {}) => ({
  id: "proposal_1",
  groupId: GROUP_ID,
  destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  amount: "10.0000000",
  assetCode: "USDC",
  assetIssuer: null,
  memo: null,
  status: "pending",
  threshold: 2,
  transactionXdr: null,
  stellarTxHash: null,
  signatures: [],
  createdAt: new Date("2026-05-01T12:00:00.000Z"),
  updatedAt: new Date("2026-05-01T12:00:00.000Z"),
  ...over,
});

const membership = (over: Record<string, any> = {}) => ({
  id: "member_1",
  groupId: GROUP_ID,
  userId: USER_ID,
  role: "member",
  joinedAt: new Date("2026-05-01T12:00:00.000Z"),
  group: {
    id: GROUP_ID,
    name: "Trip to Paris",
    description: null,
    createdAt: new Date("2026-05-01T12:00:00.000Z"),
    _count: { members: 3 },
  },
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  });
  prisma.groupMember.findMany.mockResolvedValue([]);
  prisma.treasuryProposal.findMany.mockResolvedValue([]);
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID });
});

describe("GET /groups/:groupId/treasury/proposals — cursor pagination", () => {
  const url = `/groups/${GROUP_ID}/treasury/proposals`;

  it("bounds the query and returns page metadata", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().meta).toMatchObject({
      hasMore: false,
      nextCursor: null,
      order: "desc",
    });

    // The read is bounded even when the caller asks for no page size.
    const args = prisma.treasuryProposal.findMany.mock.calls[0][0];
    expect(args.take).toBeGreaterThan(0);
    expect(args.where.groupId).toBe(GROUP_ID);
  });

  it("orders by (createdAt, id) so tied timestamps cannot repeat or skip", async () => {
    await app.inject({ method: "GET", url, headers: authHeader() });

    const args = prisma.treasuryProposal.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
  });

  it("returns a next cursor when more rows exist", async () => {
    // limit + 1 rows: the lookahead row is what makes hasMore exact.
    const rows = Array.from({ length: 3 }, (_, i) =>
      proposal({ id: `proposal_${i}`, createdAt: new Date(2026, 4, 1, 12, 0, i) })
    );
    prisma.treasuryProposal.findMany.mockResolvedValue(rows);

    const res = await app.inject({
      method: "GET",
      url: `${url}?limit=2`,
      headers: authHeader(),
    });

    const body = res.json();
    expect(body.proposals).toHaveLength(2);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toEqual(expect.any(String));
  });

  it("resumes strictly after the cursor position", async () => {
    const cursor = encodeCursor(new Date("2026-05-01T12:00:00.000Z"), "proposal_1");

    await app.inject({
      method: "GET",
      url: `${url}?cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.treasuryProposal.findMany.mock.calls[0][0];
    // The tie-break branch is what keeps rows sharing a timestamp on exactly
    // one page.
    expect(args.where.OR).toEqual([
      { createdAt: { lt: new Date("2026-05-01T12:00:00.000Z") } },
      {
        createdAt: new Date("2026-05-01T12:00:00.000Z"),
        id: { lt: "proposal_1" },
      },
    ]);
  });

  it("rejects a malformed cursor rather than silently restarting", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?cursor=not-a-real-cursor`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
    expect(prisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });

  it("rejects a page size above the maximum instead of clamping it", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?limit=${MAX_PAGE_SIZE + 1}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty page rather than an error when there are no rows", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().proposals).toEqual([]);
    expect(res.json().meta).toMatchObject({ hasMore: false, nextCursor: null });
  });

  it("checks membership before reading any row", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    prisma.group.findUnique.mockResolvedValue({ id: GROUP_ID });

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(403);
    expect(prisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });

  it("does not let a cursor widen scope beyond the caller's group", async () => {
    prisma.groupMember.findUnique.mockResolvedValue(null);
    prisma.group.findUnique.mockResolvedValue({ id: "group_2" });
    const cursor = encodeCursor(new Date("2026-05-01T12:00:00.000Z"), "proposal_1");

    const res = await app.inject({
      method: "GET",
      url: `/groups/group_2/treasury/proposals?cursor=${cursor}`,
      headers: authHeader(),
    });

    // Authorization is decided by membership, never by the cursor's contents.
    expect(res.statusCode).toBe(403);
    expect(prisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /users/:id/groups — keyset pagination", () => {
  const url = `/users/${USER_ID}/groups`;

  it("uses keyset paging by default and returns page metadata", async () => {
    prisma.groupMember.findMany.mockResolvedValue([membership()]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta).toMatchObject({ hasMore: false, nextCursor: null, limit: 10 });

    const args = prisma.groupMember.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.orderBy).toEqual([{ joinedAt: "desc" }, { id: "desc" }]);
  });

  it("keeps the original default page size of 10", async () => {
    await app.inject({ method: "GET", url, headers: authHeader() });

    const args = prisma.groupMember.findMany.mock.calls[0][0];
    // takeForPage(10) — the page plus one lookahead row.
    expect(args.take).toBe(11);
  });

  it("still honours the original offset contract for existing clients", async () => {
    prisma.groupMember.findMany.mockResolvedValue([]);

    const res = await app.inject({
      method: "GET",
      url: `${url}?page=2&limit=5`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 5, take: 5 })
    );
    // No meta on the offset path: a next cursor would describe a boundary the
    // next `page=` request does not honour.
    expect(res.json().meta).toBeUndefined();
  });

  it("prefers the cursor when a client sends both", async () => {
    const cursor = encodeCursor(new Date("2026-05-01T12:00:00.000Z"), "member_1");

    await app.inject({
      method: "GET",
      url: `${url}?page=3&cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.groupMember.findMany.mock.calls[0][0];
    expect(args.skip).toBeUndefined();
    expect(args.where.OR).toBeDefined();
  });

  it("resumes after the cursor on the joinedAt ordering", async () => {
    const at = new Date("2026-05-01T12:00:00.000Z");
    const cursor = encodeCursor(at, "member_1");

    await app.inject({
      method: "GET",
      url: `${url}?cursor=${cursor}`,
      headers: authHeader(),
    });

    const args = prisma.groupMember.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { joinedAt: { lt: at } },
      { joinedAt: at, id: { lt: "member_1" } },
    ]);
  });

  it("returns a next cursor derived from joinedAt when more rows exist", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      membership({ id: `member_${i}`, joinedAt: new Date(2026, 4, 1, 12, 0, i) })
    );
    prisma.groupMember.findMany.mockResolvedValue(rows);

    const res = await app.inject({
      method: "GET",
      url: `${url}?limit=2`,
      headers: authHeader(),
    });

    const body = res.json();
    expect(body.groups).toHaveLength(2);
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toEqual(expect.any(String));
  });

  it("rejects a malformed cursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?cursor=%%%not-base64%%%`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("rejects a page size above the maximum", async () => {
    const res = await app.inject({
      method: "GET",
      url: `${url}?limit=${MAX_PAGE_SIZE + 1}`,
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("refuses to page another user's groups", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/user_2/groups",
      headers: authHeader(USER_ID),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("does not let a cursor bypass the ownership check", async () => {
    const cursor = encodeCursor(new Date("2026-05-01T12:00:00.000Z"), "member_1");

    const res = await app.inject({
      method: "GET",
      url: `/users/user_2/groups?cursor=${cursor}`,
      headers: authHeader(USER_ID),
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty page for a user with no groups", async () => {
    prisma.groupMember.findMany.mockResolvedValue([]);

    const res = await app.inject({ method: "GET", url, headers: authHeader() });

    expect(res.statusCode).toBe(200);
    expect(res.json().groups).toEqual([]);
    expect(res.json().meta).toMatchObject({ hasMore: false, nextCursor: null });
  });
});
