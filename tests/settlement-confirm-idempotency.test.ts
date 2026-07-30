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
    loadAccount: vi.fn(),
    buildPayment: vi.fn(),
    submitPayment: vi.fn(),
    getTransaction: vi.fn(),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
  validateSignedXdr: vi.fn((_signedXdr: string, _expected: any) => ({
    tx: {} as any,
    hash: "abc123def456",
  })),
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

const fromUser = () => ({
  id: "user_1",
  stellarPublicKey: "GFROMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "From User",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const toUser = () => ({
  id: "user_2",
  stellarPublicKey: "GTOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "To User",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

function authHeader() {
  const u = fromUser();
  const token = signToken({ id: u.id, stellarPublicKey: u.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

const pendingSettlement = () => ({
  id: "settle_1",
  shortCode: "ABC123",
  groupId: "group_1",
  fromUserId: "user_1",
  toUserId: "user_2",
  amount: "12.5000000",
  assetCode: "XLM",
  assetIssuer: null,
  transactionXdr: null,
  stellarTxHash: null,
  status: "pending",
  retryCount: 0,
  failureReason: null,
  memo: "MP:ABC123",
  expenseId: null,
  expenseShareId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: fromUser(),
  to: toUser(),
});

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  prisma.settlement.findUnique.mockResolvedValue(pendingSettlement());
  prisma.settlement.findUniqueOrThrow.mockResolvedValue(pendingSettlement());
  prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
  prisma.idempotencyKey.create.mockResolvedValue({});
});

describe("POST /settlements/:id/confirm — idempotency", () => {
  it("rejects a request with no Idempotency-Key header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MISSING_IDEMPOTENCY_KEY");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("accepts the first request and transitions the settlement to submitted", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      Object.assign(pendingSettlement(), { status: "submitted", transactionXdr: "AAAA..." })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-1" },
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "settle_1" }),
        data: expect.objectContaining({
          transactionXdr: "AAAA...",
          status: "submitted",
          retryCount: 0,
          failureReason: null,
        }),
      })
    );
  });

  it("returns the cached response for a repeated key without re-submitting", async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        userId: "user_1",
        scope: "settlement.confirm",
        key: "confirm-key-2",
        requestHash: hashRequest("settlement.confirm", "settle_1", {
          signedXdr: "AAAA...",
        }),
        responseJson: JSON.stringify({
          settlement: { id: "settle_1", status: "submitted" },
        }),
      });

    await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-2" },
      payload: { signedXdr: "AAAA..." },
    });

    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1);

    const second = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-2" },
      payload: { signedXdr: "AAAA..." },
    });

    expect(second.statusCode).toBe(200);
    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1);
  });

  it("returns a conflict when the same key is reused with a different signed XDR", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "user_1",
      scope: "settlement.confirm",
      key: "confirm-key-3",
      requestHash: "hash-for-a-different-xdr",
      responseJson: JSON.stringify({ settlement: { id: "settle_1", status: "submitted" } }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-3" },
      payload: { signedXdr: "BBBB..." },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("IDEMPOTENCY_CONFLICT");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("resolves to the winner's cached response on concurrent duplicate-key races", async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        userId: "user_1",
        scope: "settlement.confirm",
        key: "confirm-race",
        requestHash: hashRequest("settlement.confirm", "settle_1", {
          signedXdr: "AAAA...",
        }),
        responseJson: JSON.stringify({
          settlement: { id: "settle_1", status: "submitted", fromUserId: "user_1" },
        }),
      });
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueViolation());

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-race" },
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
    expect(prisma.settlement.updateMany).toHaveBeenCalledTimes(1); // loser's rolled back
  });

  it("allows re-confirmation of a failed settlement with a new idempotency key", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.settlement.findUnique.mockResolvedValue(
      Object.assign(pendingSettlement(), { status: "failed", retryCount: 3, failureReason: "insufficient balance" })
    );
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      Object.assign(pendingSettlement(), { status: "submitted", transactionXdr: "NEW_XDR..." })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-retry-failed" },
      payload: { signedXdr: "NEW_XDR..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settle_1", status: { in: ["pending", "failed"] } },
        data: expect.objectContaining({
          transactionXdr: "NEW_XDR...",
          status: "submitted",
          retryCount: 0,
          failureReason: null,
        }),
      })
    );
    // A retry audit log should have been written inside the transaction
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "settlement.confirm.retry",
          metadata: expect.objectContaining({
            previousFailure: "insufficient balance",
          }),
        }),
      })
    );
  });

  it("returns current state for a completed settlement without modifying it", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.settlement.findUnique.mockResolvedValue(
      Object.assign(pendingSettlement(), {
        status: "completed",
        transactionXdr: "ORIG_XDR",
        stellarTxHash: "hash_abc",
      })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-completed" },
      payload: { signedXdr: "ORIG_XDR" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("completed");
    // The handler returns early for completed/submitted settlements, so
    // updateMany and audit are never called — the settlement is not modified.
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });
});


