/**
 * POST /settlements/:id/confirm must validate the signed XDR against the
 * settlement's own recorded intent (source, destination, asset, amount,
 * memo) before ever persisting it — a wallet that returns a different,
 * still-validly-signed transaction must be rejected rather than silently
 * accepted and only discovered later when the worker submits it.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  const prisma: any = {
    settlement: model(),
    groupMember: model(),
    idempotencyKey: model(),
    statusHistory: model(),
    auditLog: { create: vi.fn() },
    groupMember: model(),
    group: model(),
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
import { config } from "../src/config";

const prisma = h.prisma;

const payerKeypair = Keypair.random();
const sharerKeypair = Keypair.random();

const from = () => ({
  id: "user_1",
  stellarPublicKey: sharerKeypair.publicKey(),
  displayName: "Sharer",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});
const to = () => ({
  id: "payer_1",
  stellarPublicKey: payerKeypair.publicKey(),
  displayName: "Payer",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

function authHeader() {
  const u = from();
  const token = signToken({ id: u.id, stellarPublicKey: u.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

const fakeSettlement = () => ({
  id: "settle_1",
  shortCode: "SC001",
  groupId: "group_1",
  fromUserId: "user_1",
  toUserId: "payer_1",
  amount: "10.0000000",
  assetCode: "XLM",
  assetIssuer: null,
  status: "pending",
  memo: "MP:SC001",
  expenseId: "expense_1",
  expenseShareId: "share_1",
  stellarTxHash: null,
  transactionXdr: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: from(),
  to: to(),
});

/** Build and sign a payment XDR — parameters default to matching the settlement's intent. */
function signedPaymentXdr(
  overrides: Partial<{
    destination: string;
    amount: string;
    memo: string;
    signer: Keypair;
  }> = {}
): string {
  const account = new Account(sharerKeypair.publicKey(), "12345");
  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 2),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: overrides.destination ?? payerKeypair.publicKey(),
        asset: Asset.native(),
        amount: overrides.amount ?? "10.0000000",
      })
    )
    .addMemo(Memo.text(overrides.memo ?? "MP:SC001"))
    .setTimeout(300)
    .build();
  tx.sign(overrides.signer ?? sharerKeypair);
  return tx.toXDR();
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  // Membership check for requireMembership
  prisma.groupMember.findUnique.mockResolvedValue({ groupId: "group_1", userId: "user_1", role: "member" });
  prisma.group.findUnique.mockResolvedValue({ id: "group_1" });
});

describe("POST /settlements/:id/confirm — XDR intent validation", () => {
  it("accepts a signed XDR that matches the settlement's recorded intent", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      ...fakeSettlement(),
      status: "submitted",
      transactionXdr: "will-be-overwritten",
    });
    prisma.auditLog.create.mockResolvedValue({});
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-1" },
      payload: { signedXdr: signedPaymentXdr() },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.settlement.updateMany).toHaveBeenCalled();
  });

  it("rejects a signed XDR paying a different destination than the settlement records, without persisting it", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const attacker = Keypair.random();
    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-2" },
      payload: { signedXdr: signedPaymentXdr({ destination: attacker.publicKey() }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a signed XDR for a different amount than the settlement records", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-3" },
      payload: { signedXdr: signedPaymentXdr({ amount: "999.0000000" }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a signed XDR with an altered memo", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-4" },
      payload: { signedXdr: signedPaymentXdr({ memo: "MP:OTHERXX" }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
  });

  it("rejects a signed XDR from an unrelated signer (not the settlement's payer share)", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const impostor = Keypair.random();
    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-5" },
      payload: { signedXdr: signedPaymentXdr({ signer: impostor }) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
  });

  it("rejects malformed XDR without touching the database", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-6" },
      payload: { signedXdr: "not-a-real-xdr" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MALFORMED");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });
});
