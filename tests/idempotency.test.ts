import crypto from "node:crypto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
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

const idem = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("../src/services/idempotency", () => ({
  claimIdempotencyKey: idem.claim,
  completeIdempotencyKey: idem.complete,
  failIdempotencyKey: idem.fail,
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
  transactionXdr: null,
  retryCount: 0,
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

function expectedHash(settlement: ReturnType<typeof fakeSettlement>, signedXdr: string): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        settlementId: settlement.id,
        amount: settlement.amount.toString(),
        assetCode: settlement.assetCode,
        assetIssuer: settlement.assetIssuer,
        fromUserId: settlement.fromUserId,
        toUserId: settlement.toUserId,
        memo: settlement.memo,
        signedXdr,
      })
    )
    .digest("hex");
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  idem.claim.mockResolvedValue({ outcome: "claimed", id: "idem_1" });
  if (!app) app = await buildApp();
});

describe("idempotency — confirm endpoint", () => {
  const signedXdr = "AAAA...";

  it("claims the key, stores the signed XDR, and completes the record with the response", async () => {
    const settlement = fakeSettlement();
    prisma.settlement.findUnique.mockResolvedValue(settlement);
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: signedXdr })
    );
    const { stellar } = await import("../src/services/stellar");

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");

    expect(idem.claim).toHaveBeenCalledWith(
      "user_1",
      "key-001",
      expectedHash(settlement, signedXdr)
    );
    expect(idem.complete).toHaveBeenCalledWith(
      "idem_1",
      expect.objectContaining({ settlement: expect.objectContaining({ status: "submitted" }) })
    );
    // The worker handles Stellar submission; confirm endpoint only stores the XDR.
    expect(stellar.submitPayment).not.toHaveBeenCalled();
  });

  it("replays the stored response without reprocessing when the claim is already completed", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    const storedResponse = { settlement: { id: "settle_1", status: "submitted" } };
    idem.claim.mockResolvedValueOnce({
      outcome: "completed",
      responseJson: JSON.stringify(storedResponse),
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(storedResponse);
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("returns 409 IDEMPOTENCY_CONFLICT when the key was used for a different settlement intent", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    idem.claim.mockResolvedValueOnce({ outcome: "conflict" });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr: "different-xdr" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("IDEMPOTENCY_CONFLICT");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("returns 409 IDEMPOTENCY_IN_PROGRESS for a concurrent request under the same key", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    idem.claim.mockResolvedValueOnce({ outcome: "in_progress" });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("IDEMPOTENCY_IN_PROGRESS");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("marks the claimed key failed and rethrows the original error when processing fails", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockRejectedValueOnce(new Error("db unavailable"));

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(500);
    expect(idem.fail).toHaveBeenCalledWith("idem_1");
    expect(idem.complete).not.toHaveBeenCalled();
  });

  it("completes the claim without reprocessing when the settlement is no longer pending", async () => {
    const confirmed = fakeSettlement({ status: "confirmed" });
    prisma.settlement.findUnique.mockResolvedValue(confirmed);

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("confirmed");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
    expect(idem.complete).toHaveBeenCalledWith("idem_1", expect.any(Object));
  });

  it("works without an idempotency key for backward compatibility", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: "CCCCC..." })
    );
    const { stellar } = await import("../src/services/stellar");

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "CCCCC..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
    expect(stellar.submitPayment).not.toHaveBeenCalled();
    expect(idem.claim).not.toHaveBeenCalled();
  });
});
