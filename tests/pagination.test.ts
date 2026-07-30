import { describe, it, expect, beforeEach, vi } from "vitest";
import { encodeCursor } from "../src/lib/pagination";
import { signToken } from "../src/plugins/auth";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(async () => []),
  });
  return {
    prisma: {
      expense: model(),
      groupMember: model(),
      group: model(),
      $transaction: vi.fn(async (arg: any) => Promise.all(arg)),
    },
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

const fakeUser = () => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

describe("Pagination routes", () => {
  const groupId = "group_1";

  beforeEach(() => {
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId,
      userId: "user_1",
      role: "member",
    } as any);
  });

  it("returns unauthorized if not a group member", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null as any);
    prisma.group.findUnique.mockResolvedValueOnce({ id: groupId } as any);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns the first page and a nextCursor when hasMore is true", async () => {
    const expenses = [
      { id: "3", createdAt: new Date("2026-02-03T00:00:00Z"), amount: "30", payer: { id: "user_1", stellarPublicKey: "ABC", createdAt: new Date() }, shares: [] },
      { id: "2", createdAt: new Date("2026-02-02T00:00:00Z"), amount: "20", payer: { id: "user_1", stellarPublicKey: "ABC", createdAt: new Date() }, shares: [] },
      { id: "1", createdAt: new Date("2026-02-01T00:00:00Z"), amount: "10", payer: { id: "user_1", stellarPublicKey: "ABC", createdAt: new Date() }, shares: [] },
    ];
    // limit is 2, take is 3. We return 3 items from DB.
    prisma.expense.findMany.mockResolvedValueOnce(expenses as any);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses?limit=2`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expenses).toHaveLength(2);
    expect(body.expenses[0].id).toBe("3");
    expect(body.expenses[1].id).toBe("2");
    expect(body.meta.hasMore).toBe(true);
    expect(body.meta.nextCursor).toBe(encodeCursor(expenses[1].createdAt, expenses[1].id));
  });

  it("fetches subsequent page using cursor", async () => {
    const cursor = encodeCursor(new Date("2026-02-02T00:00:00Z"), "2");
    prisma.expense.findMany.mockResolvedValueOnce([
      { id: "1", createdAt: new Date("2026-02-01T00:00:00Z"), amount: "10", payer: { id: "user_1", stellarPublicKey: "ABC", createdAt: new Date() }, shares: [] },
    ] as any);

    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses?limit=2&cursor=${cursor}`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expenses).toHaveLength(1);
    expect(body.meta.hasMore).toBe(false);
    expect(body.meta.nextCursor).toBeNull();
    
    // Check if the query filter used the decoded cursor
    const callArgs = prisma.expense.findMany.mock.calls[0]?.[0] as any;
    expect(callArgs?.where.OR).toBeDefined();
  });

  it("handles equal timestamps safely without duplicates", async () => {
    const cursor = encodeCursor(new Date("2026-02-02T00:00:00Z"), "2");
    prisma.expense.findMany.mockResolvedValueOnce([] as any);

    await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses?limit=2&cursor=${cursor}`,
      headers: authHeader(),
    });
    
    const callArgs = prisma.expense.findMany.mock.calls[0]?.[0] as any;
    const orFilter = callArgs?.where.OR;
    // Expected logic: lt timestamp OR (eq timestamp AND lt id)
    expect(orFilter[0].createdAt.lt).toEqual(new Date("2026-02-02T00:00:00Z"));
    expect(orFilter[1].createdAt).toEqual(new Date("2026-02-02T00:00:00Z"));
    expect(orFilter[1].id.lt).toBe("2");
  });

  it("returns 400 for an invalid cursor", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses?limit=2&cursor=not_a_valid_base64_string_xyz`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_CURSOR");
  });

  it("enforces maximum limits and returns 400 for invalid limits", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses?limit=9999`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
  });

  it("handles empty results gracefully", async () => {
    prisma.expense.findMany.mockResolvedValueOnce([] as any);
    const res = await app.inject({
      method: "GET",
      url: `/groups/${groupId}/expenses?limit=10`,
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expenses).toHaveLength(0);
    expect(res.json().meta.hasMore).toBe(false);
    expect(res.json().meta.nextCursor).toBeNull();
  });
});
