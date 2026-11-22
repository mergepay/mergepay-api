import { beforeEach, describe, expect, it, vi } from "vitest";
import { signToken } from "../../src/plugins/auth";
import { encodeMemberCursor, GROUP_LIST_MAX_PAGE_SIZE } from "../../src/lib/pagination";

const h = vi.hoisted(() => ({
  prisma: {
    group: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;
const GROUP_ID = "group_1";
const USER_ID = "user_1";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function authHeader() {
  return {
    authorization: `Bearer ${signToken({ id: USER_ID, stellarPublicKey: PUBLIC_KEY })}`,
  };
}

const user = (id: string, displayName: string) => ({
  id,
  stellarPublicKey: PUBLIC_KEY,
  displayName,
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const member = (id: string, displayName: string) => ({
  id,
  groupId: GROUP_ID,
  userId: id,
  role: "member",
  joinedAt: new Date("2026-01-01T00:00:00.000Z"),
  user: user(id, displayName),
});

async function detail(query = "") {
  return app.inject({
    method: "GET",
    url: `/groups/${GROUP_ID}${query}`,
    headers: authHeader(),
  });
}

function lastFindManyArgs() {
  const calls = prisma.groupMember.findMany.mock.calls;
  return calls[calls.length - 1]?.[0] as any;
}

beforeEach(async () => {
  vi.clearAllMocks();
  app = await buildApp();
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "admin",
  });
  prisma.group.findUnique.mockResolvedValue({
    id: GROUP_ID,
    name: "Trip",
    description: null,
    createdByUserId: USER_ID,
    treasuryEnabled: false,
    treasuryAccountPublicKey: null,
    treasuryRequiredSigners: null,
    archived: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  });
});

describe("GET /groups/:id member pagination", () => {
  it("returns the first alphabetical page with standard metadata", async () => {
    prisma.groupMember.findMany.mockResolvedValueOnce([
      member("m1", "Ada"),
      member("m2", "Bob"),
      member("m3", "Zo"),
    ]);

    const res = await detail("?limit=2");
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.members.map((m: any) => m.user.displayName)).toEqual(["Ada", "Bob"]);
    expect(body.meta).toMatchObject({
      hasMore: true,
      limit: 2,
      order: "asc",
      nextCursor: encodeMemberCursor("Bob", "m2"),
    });
    expect(lastFindManyArgs()).toMatchObject({
      take: 3,
      orderBy: [{ user: { displayName: "asc" } }, { id: "asc" }],
    });
  });

  it("resumes after the cursor without returning the cursor row", async () => {
    prisma.groupMember.findMany.mockResolvedValueOnce([member("m3", "Zo")]);

    const res = await detail(`?limit=2&cursor=${encodeMemberCursor("Bob", "m2")}`);
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.members).toHaveLength(1);
    expect(body.meta.nextCursor).toBeNull();
    expect(lastFindManyArgs().where).toMatchObject({
      groupId: GROUP_ID,
      OR: [
        { user: { displayName: { gt: "Bob" } } },
        { user: { displayName: "Bob" }, id: { gt: "m2" } },
      ],
    });
  });

  it("uses the id as a tiebreaker when display names are identical", async () => {
    prisma.groupMember.findMany.mockResolvedValueOnce([
      member("m2", "Ada"),
      member("m3", "Ada"),
    ]);

    const res = await detail(`?limit=2&cursor=${encodeMemberCursor("Ada", "m1")}`);

    expect(res.statusCode).toBe(200);
    expect(res.json().members.map((m: any) => m.id)).toEqual(["m2", "m3"]);
    expect(lastFindManyArgs().where.OR[1]).toEqual({
      user: { displayName: "Ada" },
      id: { gt: "m1" },
    });
  });

  it(`accepts limit=${GROUP_LIST_MAX_PAGE_SIZE} and rejects one above it`, async () => {
    prisma.groupMember.findMany.mockResolvedValue([]);

    const ok = await detail(`?limit=${GROUP_LIST_MAX_PAGE_SIZE}`);
    const tooBig = await detail(`?limit=${GROUP_LIST_MAX_PAGE_SIZE + 1}`);

    expect(ok.statusCode).toBe(200);
    expect(tooBig.statusCode).toBe(400);
    expect(tooBig.json().code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed cursor", async () => {
    const res = await detail("?cursor=not-a-cursor");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
    expect(prisma.groupMember.findMany).not.toHaveBeenCalled();
  });

  it("honors descending order through the same cursor contract", async () => {
    prisma.groupMember.findMany.mockResolvedValueOnce([member("m1", "Ada")]);

    const res = await detail("?order=desc");

    expect(res.statusCode).toBe(200);
    expect(res.json().meta.order).toBe("desc");
    expect(lastFindManyArgs().orderBy).toEqual([
      { user: { displayName: "desc" } },
      { id: "desc" },
    ]);
  });
});
