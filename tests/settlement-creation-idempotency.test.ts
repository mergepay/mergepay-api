import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  const prisma: any = {
    expense: model(),
    expenseShare: model(),
    groupMember: model(),
    group: model(),
    settlement: model(),
    idempotencyKey: model(),
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(async () => ({
      exists: true,
      sequence: "1",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    })),
    buildPayment: vi.fn(() => "unsigned-xdr"),
    submitPayment: vi.fn(),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { hashRequest } from "../src/services/idempotency";

const prisma = h.prisma;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
  });
}

const payer = () => ({
  id: "payer_1",
  stellarPublicKey: "GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Payer",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const sharer = () => ({
  id: "user_1",
  stellarPublicKey: "GSHAREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Sharer",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

function authHeader() {
  const u = sharer();
  const token = signToken({ id: u.id, stellarPublicKey: u.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

const fakeExpense = () => ({
  id: "expense_1",
  groupId: "group_1",
  payerUserId: "payer_1",
  title: "Dinner",
  assetCode: "XLM",
  assetIssuer: null,
  payer: payer(),
  shares: [
    { id: "share_1", expenseId: "expense_1", userId: "user_1", shareAmount: "10", status: "pending" },
  ],
});

const fakeCreatedSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_new",
  shortCode: "XYZ999",
  groupId: "group_1",
  fromUserId: "user_1",
  toUserId: "payer_1",
  amount: "10",
  assetCode: "XLM",
  assetIssuer: null,
  status: "pending",
  memo: "MP:XYZ999",
  expenseId: "expense_1",
  expenseShareId: "share_1",
  stellarTxHash: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  from: sharer(),
  to: payer(),
  ...over,
});

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  prisma.expense.findUnique.mockResolvedValue(fakeExpense());
  prisma.groupMember.findUnique.mockResolvedValue({ id: "gm_1", groupId: "group_1", userId: "user_1", role: "member" });
  prisma.expenseShare.findUnique.mockResolvedValue({
    id: "share_1",
    status: "pending",
  });
  prisma.expenseShare.update.mockResolvedValue({});
  prisma.settlement.create.mockResolvedValue(fakeCreatedSettlement());
  prisma.idempotencyKey.create.mockResolvedValue({});
});

describe("POST /expenses/:id/settle — idempotency", () => {
  it("creates exactly one settlement per idempotency key on repeat requests", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);

    const first = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "settle-key-1" },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    expect(prisma.settlement.create).toHaveBeenCalledTimes(1);
    const stored = prisma.idempotencyKey.create.mock.calls[0][0].data;

    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      ...stored,
      responseJson: JSON.stringify(first.json()),
    });

    const second = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "settle-key-1" },
      payload: {},
    });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // Still only created once — the repeat never touched settlement.create again.
    expect(prisma.settlement.create).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict when the same key is reused for a different request", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "user_1",
      scope: "settlement.create",
      key: "settle-key-1",
      requestHash: "hash-for-a-different-body",
      responseJson: JSON.stringify({ settlement: { id: "other" } }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "settle-key-1" },
      payload: { assetCode: "USDC" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe("IDEMPOTENCY_CONFLICT");
    expect(prisma.settlement.create).not.toHaveBeenCalled();
  });

  it("never creates a duplicate settlement when two concurrent requests share a key", async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        userId: "user_1",
        scope: "settlement.create",
        key: "settle-key-race",
        requestHash: hashRequest("settlement.create", "expense_1", {}),
        responseJson: JSON.stringify({
          settlement: fakeCreatedSettlement(),
          xdr: "unsigned-xdr",
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      });
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueViolation());

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "settle-key-race" },
      payload: {},
    });

    // Our attempt did run settlement.create (its writes would roll back with
    // the real transaction in production), but the client only ever sees a
    // single logical settlement in the response, never a duplicate-creation
    // error surfaced as a 500.
    expect(res.statusCode).toBe(200);
    expect(prisma.settlement.create).toHaveBeenCalledTimes(1);
  });

  it("rejects settling an already-settled share even with a fresh idempotency key", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.expenseShare.findUnique.mockResolvedValue({ id: "share_1", status: "settled" });

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "settle-key-2" },
      payload: {},
    });

    expect(res.statusCode).toBe(409);
    expect(prisma.settlement.create).not.toHaveBeenCalled();
  });
});
