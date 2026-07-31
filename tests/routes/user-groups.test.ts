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
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

describe("GET /users/:id/groups", () => {
  it("requires authentication", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/users/user_1/groups",
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when trying to fetch another user's groups", async () => {
    const user = fakeUser({ id: "user_1" });
    const res = await app.inject({
      method: "GET",
      url: "/users/user_2/groups",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 404 when the user does not exist", async () => {
    const user = fakeUser({ id: "user_1" });
    prisma.user.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "GET",
      url: "/users/user_1/groups",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns user's groups successfully", async () => {
    const user = fakeUser({ id: "user_1" });
    prisma.user.findUnique.mockResolvedValueOnce(user);

    const mockGroup = {
      id: "group_1",
      name: "Trip to Paris",
      description: "Paris trip expenses",
      createdAt: new Date("2026-05-01T12:00:00.000Z"),
      _count: { members: 3 },
    };

    prisma.groupMember.findMany.mockResolvedValueOnce([
      {
        id: "member_1",
        groupId: "group_1",
        userId: "user_1",
        joinedAt: new Date("2026-05-01T12:00:00.000Z"),
        group: mockGroup,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/users/user_1/groups",
      headers: authHeader(user),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]).toEqual({
      id: "group_1",
      name: "Trip to Paris",
      description: "Paris trip expenses",
      memberCount: 3,
      createdAt: "2026-05-01T12:00:00.000Z",
    });
  });

  it("handles pagination parameters correctly", async () => {
    const user = fakeUser({ id: "user_1" });
    prisma.user.findUnique.mockResolvedValueOnce(user);
    prisma.groupMember.findMany.mockResolvedValueOnce([]);

    const res = await app.inject({
      method: "GET",
      url: "/users/user_1/groups?page=2&limit=5",
      headers: authHeader(user),
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.groupMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 5,
        take: 5,
      })
    );
  });
});
