import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  });
  const prisma: any = {
    idempotencyKey: model(),
    settlement: { findUnique: vi.fn(), update: vi.fn() },
    expenseShare: { update: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

// Use the real stellar service so signed-XDR validation actually runs.
vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return { ...actual };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { stellar } from "../src/services/stellar";

const prisma = h.prisma;

const from = Keypair.random();
const to = Keypair.random();

const fakeUser = () => ({
  id: "user_1",
  stellarPublicKey: from.publicKey(),
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const recipient = () => ({
  id: "user_2",
  stellarPublicKey: to.publicKey(),
  displayName: "Recipient",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const fakeSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  groupId: "group_1",
  shortCode: "ABC123",
  fromUserId: "user_1",
  toUserId: "user_2",
  amount: "10.0000000",
  assetCode: "XLM",
  assetIssuer: null,
  status: "pending",
  transactionXdr: null,
  retryCount: 0,
  memo: "MP:ABC123",
  expenseId: null,
  expenseShareId: null,
  stellarTxHash: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: fakeUser(),
  to: recipient(),
  ...over,
});

function authHeader() {
  const user = fakeUser();
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

function buildValidXdr(over: { destination?: string; amount?: string; memoCode?: string } = {}) {
  return stellar.buildPayment({
    sourcePublicKey: from.publicKey(),
    sourceSequence: "1",
    destination: over.destination ?? to.publicKey(),
    asset: { code: "XLM", issuer: null },
    amount: over.amount ?? "10.0000000",
    memoCode: over.memoCode ?? "ABC123",
  });
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("settlement confirm — signed XDR intent validation", () => {
  it("rejects a signed XDR whose destination was swapped, without persisting anything", async () => {
    const attacker = Keypair.random().publicKey();
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: buildValidXdr({ destination: attacker }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("rejects a signed XDR whose amount was changed, without persisting anything", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: buildValidXdr({ amount: "999.0000000" }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("rejects malformed XDR input with a client error instead of a crash", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "not-a-real-xdr" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("accepts a signed XDR that matches the settlement intent exactly", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: "signed" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: buildValidXdr() },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
    expect(prisma.settlement.update).toHaveBeenCalled();
  });
});
