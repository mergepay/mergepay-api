import { describe, it, expect, beforeEach, vi } from "vitest";
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
    treasuryProposal: model(),
    treasuryApproval: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: model(),
    webhook: model(),
    webhookDelivery: model(),
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
import { encodeCursor } from "../src/lib/pagination";
import { treasuryProposalListQuerySchema } from "../src/validations/treasury";

const prisma = h.prisma;

const fakeUser = () => ({
  id: "user_" + Math.random().toString(36).slice(2, 8),
  stellarPublicKey: Keypair.random().publicKey(),
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

function asMember(user: { id: string }) {
  prisma.groupMember.findUnique.mockResolvedValueOnce({
    groupId: "group_1",
    userId: user.id,
    role: "member",
  });
}

async function list(query: string, user = fakeUser()) {
  asMember(user);
  return app.inject({
    method: "GET",
    url: `/groups/group_1/treasury/proposals${query}`,
    headers: authHeader(user),
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("treasuryProposalListQuerySchema", () => {
  it("applies pagination defaults", () => {
    const parsed = treasuryProposalListQuerySchema.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.order).toBe("desc");
    expect(parsed.status).toBeUndefined();
  });

  it("accepts every lifecycle status", () => {
    for (const status of [
      "pending",
      "awaiting_signatures",
      "submitted",
      "confirmed",
      "failed",
      "expired",
    ]) {
      expect(treasuryProposalListQuerySchema.parse({ status }).status).toBe(status);
    }
  });

  it("rejects an unknown status", () => {
    expect(treasuryProposalListQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);
  });

  it("rejects unknown query keys", () => {
    expect(treasuryProposalListQuerySchema.safeParse({ page: "2" }).success).toBe(false);
  });

  it("rejects an inverted date range", () => {
    const result = treasuryProposalListQuerySchema.safeParse({
      startDate: "2026-05-02T00:00:00Z",
      endDate: "2026-05-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("accepts an equal-boundary date range", () => {
    const result = treasuryProposalListQuerySchema.safeParse({
      startDate: "2026-05-01T00:00:00Z",
      endDate: "2026-05-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("GET /groups/:groupId/treasury/proposals filtering", () => {
  it("scopes by group with no filters", async () => {
    const res = await list("");
    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: "group_1" },
        take: 51,
      })
    );
  });

  it("filters by status", async () => {
    const res = await list("?status=confirmed");
    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: "group_1", status: "confirmed" },
      })
    );
  });

  it("filters by creatorId", async () => {
    const res = await list("?creatorId=user_42");
    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { groupId: "group_1", creatorId: "user_42" },
      })
    );
  });

  it("filters by creation date range", async () => {
    const res = await list(
      "?startDate=2026-05-01T00:00:00Z&endDate=2026-05-31T23:59:59Z"
    );
    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          groupId: "group_1",
          createdAt: {
            gte: new Date("2026-05-01T00:00:00Z"),
            lte: new Date("2026-05-31T23:59:59Z"),
          },
        },
      })
    );
  });

  it("supports a one-sided date range", async () => {
    const res = await list("?startDate=2026-05-01T00:00:00Z");
    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          groupId: "group_1",
          createdAt: { gte: new Date("2026-05-01T00:00:00Z") },
        },
      })
    );
  });

  it("combines filters with cursor pagination", async () => {
    const cursorDate = new Date("2026-05-10T00:00:00.000Z");
    const cursor = encodeCursor(cursorDate, "prop_9");
    const res = await list(
      `?status=failed&creatorId=user_42&cursor=${cursor}&limit=5&order=asc`
    );
    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          groupId: "group_1",
          status: "failed",
          creatorId: "user_42",
          OR: [
            { createdAt: { gt: cursorDate } },
            { createdAt: cursorDate, id: { gt: "prop_9" } },
          ],
        }),
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: 6,
      })
    );
  });

  it("rejects an unknown status with 400", async () => {
    const res = await list("?status=bogus");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(prisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });

  it("rejects unknown query parameters with 400", async () => {
    const res = await list("?page=2");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a malformed date with 400", async () => {
    const res = await list("?startDate=yesterday");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an inverted date range with 400", async () => {
    const res = await list(
      "?startDate=2026-05-02T00:00:00Z&endDate=2026-05-01T00:00:00Z"
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects an out-of-range limit with 400", async () => {
    expect((await list("?limit=0")).statusCode).toBe(400);
    expect((await list("?limit=101")).statusCode).toBe(400);
  });

  it("rejects an unknown order with 400", async () => {
    const res = await list("?order=sideways");
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty creatorId with 400", async () => {
    const res = await list("?creatorId=");
    expect(res.statusCode).toBe(400);
  });

  it("still requires membership before reading rows", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);
    prisma.group.findUnique.mockResolvedValueOnce({ id: "group_1" });
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/treasury/proposals?status=confirmed",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(403);
    expect(prisma.treasuryProposal.findMany).not.toHaveBeenCalled();
  });
});
