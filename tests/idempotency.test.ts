import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    create: vi.fn(),
  });
  const prisma: any = {
    idempotencyKey: model(),
    settlement: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    expenseShare: {
      update: vi.fn(),
    },
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
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;

const fakeUser = () => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const fakeSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  groupId: "group_1",
  shortCode: "ABC123",
  fromUserId: "user_1",
  toUserId: "user_2",
  amount: "10.00",
  assetCode: "USDC",
  assetIssuer: "GABCDEF...",
  status: "pending",
  memo: "MP:ABC123",
  expenseId: null,
  expenseShareId: null,
  stellarTxHash: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  from: fakeUser(),
  to: {
    id: "user_2",
    stellarPublicKey: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    displayName: "Recipient",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  },
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("idempotency — confirm endpoint", () => {
  it("first confirm with a key submits and stores the response", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "confirmed", stellarTxHash: "txhash_1" })
    );
    const { stellar } = await import("../src/services/stellar");
    (stellar.submitPayment as any).mockResolvedValue("txhash_1");

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: {
        ...authHeader(),
        "idempotency-key": "key-001",
      },
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settlement.status).toBe("confirmed");
    expect(body.settlement.stellarTxHash).toBe("txhash_1");

    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: {
        key: "key-001",
        requestHash: expect.any(String),
        responseJson: expect.any(String),
      },
    });
    expect(stellar.submitPayment).toHaveBeenCalledTimes(1);
  });

  it("repeat confirm with same key + same body returns stored response and does not call Horizon again", async () => {
    const payload = { signedXdr: "AAAA..." };
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const storedResponse = JSON.stringify({
      settlement: {
        id: "settle_1",
        status: "confirmed",
        stellarTxHash: "txhash_1",
      },
    });
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: "key-001",
      requestHash,
      responseJson: storedResponse,
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: {
        ...authHeader(),
        "idempotency-key": "key-001",
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settlement.status).toBe("confirmed");

    const { stellar } = await import("../src/services/stellar");
    expect(stellar.submitPayment).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("same key + different body returns 409 idempotency_conflict", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: "key-001",
      requestHash: "different-hash",
      responseJson: JSON.stringify({ settlement: { status: "confirmed" } }),
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: {
        ...authHeader(),
        "idempotency-key": "key-001",
      },
      payload: { signedXdr: "BBBBB..." },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error).toBe("idempotency_conflict");

    const { stellar } = await import("../src/services/stellar");
    expect(stellar.submitPayment).not.toHaveBeenCalled();
  });

  it("works without idempotency key for backward compatibility", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "confirmed", stellarTxHash: "txhash_2" })
    );
    const { stellar } = await import("../src/services/stellar");
    (stellar.submitPayment as any).mockResolvedValue("txhash_2");

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "CCCCC..." },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settlement.status).toBe("confirmed");
    expect(stellar.submitPayment).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });
});
