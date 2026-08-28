import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

// ─── mock Prisma ────────────────────────────────────────────────────────────
const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
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
    statusHistory: model(),
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

const mockGetTransaction = vi.fn();
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
    getTransaction: (...args: any[]) => mockGetTransaction(...args),
    hashOf: vi.fn(() => "deadbeef"),
    validateSignedPaymentXdr: vi.fn(() => ({
      sourcePublicKey: "GSHAREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      destination: "GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      asset: { code: "XLM", issuer: null },
      amount: "10",
      memoCode: "XYZ999",
      expiresAt: new Date(Date.now() + 3600000),
    })),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
  parseSignedPaymentXdr: vi.fn(() => ({})),
  validateSignedXdr: vi.fn(() => ({
    tx: {},
    hash: "abc123def456",
  })),
  validatePaymentTx: vi.fn(),
}));

const mockApplyTransition = vi.fn();
vi.mock("../src/services/settlement-machine", () => ({
  applySettlementTransition: (...args: any[]) => mockApplyTransition(...args),
  isTerminalSettlementStatus: (s: string) =>
    s === "confirmed" || s === "failed",
  canTransitionSettlementStatus: () => true,
}));

vi.mock("../src/services/settlement-xdr", () => ({
  validateSettlementXdr: vi.fn(() => ({ tx: {}, hash: "abc123def456" })),
  settlementPaymentIntent: vi.fn(() => ({
    sourcePublicKey: "GSHAREAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    destination: "GPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    asset: { code: "XLM", issuer: null },
    amount: "10",
    memoCode: "XYZ999",
    expiresAt: new Date(Date.now() + 3600000),
    resource: "settlement",
  })),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;

// ─── helpers ────────────────────────────────────────────────────────────────
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
    {
      id: "share_1",
      expenseId: "expense_1",
      userId: "user_1",
      shareAmount: "10",
      status: "pending",
    },
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
  idempotencyKey: null,
  expenseId: "expense_1",
  expenseShareId: "share_1",
  stellarTxHash: null,
  transactionXdr: null,
  retryCount: 0,
  failureReason: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: sharer(),
  to: payer(),
  statusHistory: [],
  ...over,
});

const pendingConfirmSettlement = (over: Record<string, any> = {}) => ({
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
  errorCategory: null,
  memo: "MP:ABC123",
  expenseId: null,
  expenseShareId: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: sharer(),
  to: payer(),
  statusHistory: [],
  ...over,
});

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

// ─── creation idempotency ───────────────────────────────────────────────────

describe("POST /expenses/:id/settle — settlement-level idempotency", () => {
  beforeEach(() => {
    prisma.expense.findUnique.mockResolvedValue(fakeExpense());
    prisma.groupMember.findUnique.mockResolvedValue({
      id: "gm_1",
      groupId: "group_1",
      userId: "user_1",
      role: "member",
    });
    prisma.expenseShare.findUnique.mockResolvedValue({
      id: "share_1",
      status: "pending",
    });
    prisma.expenseShare.update.mockResolvedValue({});
    prisma.idempotencyKey.create.mockResolvedValue({});
  });

  it("stores the idempotency key on the settlement record", async () => {
    prisma.settlement.findFirst.mockResolvedValue(null);
    prisma.settlement.create.mockResolvedValue(
      fakeCreatedSettlement({ idempotencyKey: "share-key-1" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "share-key-1" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.settlement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          idempotencyKey: "share-key-1",
        }),
      })
    );
  });

  it("returns the existing settlement when DB-level duplicate is detected", async () => {
    const existing = fakeCreatedSettlement({ idempotencyKey: "dup-key" });
    prisma.settlement.findFirst.mockResolvedValue(existing);

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "dup-key" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().duplicate).toBe(true);
    expect(prisma.settlement.create).not.toHaveBeenCalled();
  });

  it("does not block a retry when the first settlement failed", async () => {
    prisma.settlement.findFirst.mockResolvedValue(null);
    prisma.settlement.create.mockResolvedValue(
      fakeCreatedSettlement({ idempotencyKey: "retry-key" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/expenses/expense_1/settle",
      headers: { ...authHeader(), "idempotency-key": "retry-key" },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.settlement.create).toHaveBeenCalled();
  });
});

// ─── confirm Stellar timeout reconciliation ─────────────────────────────────

describe("POST /settlements/:id/confirm — safe Stellar timeout reconciliation", () => {
  const fromUser = sharer();

  function confirmAuthHeader() {
    const token = signToken({
      id: fromUser.id,
      stellarPublicKey: fromUser.stellarPublicKey,
    });
    return { authorization: `Bearer ${token}` };
  }

  beforeEach(() => {
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: fromUser.id,
      role: "member",
    });
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      pendingConfirmSettlement()
    );
  });

  it("reconciles a submitted settlement against the ledger when the user retries after timeout", async () => {
    const submitted = pendingConfirmSettlement({
      status: "submitted",
      transactionXdr: "SIGNED_XDR",
      stellarTxHash: "tx_hash_abc",
    });

    const confirmed = pendingConfirmSettlement({
      status: "confirmed",
      transactionXdr: "SIGNED_XDR",
      stellarTxHash: "tx_hash_abc",
    });

    // findUnique is called: (1) for validation before runIdempotent,
    // (2) inside the operation to re-read, (3) after the transition.
    // All must return "submitted" until the transition updates the row.
    prisma.settlement.findUnique
      .mockResolvedValueOnce(submitted)
      .mockResolvedValueOnce(submitted)
      .mockResolvedValueOnce(confirmed);

    mockGetTransaction.mockResolvedValue({ successful: true });
    mockApplyTransition.mockResolvedValue({
      settlement: { id: "settle_1", status: "confirmed", expenseShareId: null },
      changed: true,
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...confirmAuthHeader(), "idempotency-key": "reconcile-key" },
      payload: { signedXdr: "SIGNED_XDR" },
    });

    expect(res.statusCode).toBe(200);
    expect(mockGetTransaction).toHaveBeenCalledWith("tx_hash_abc");
    expect(mockApplyTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        settlementId: "settle_1",
        nextStatus: "confirmed",
      })
    );
  });

  it("returns persisted state when Horizon is unreachable during reconciliation", async () => {
    const submitted = pendingConfirmSettlement({
      status: "submitted",
      transactionXdr: "SIGNED_XDR",
      stellarTxHash: "tx_hash_abc",
    });
    prisma.settlement.findUnique.mockResolvedValue(submitted);
    mockGetTransaction.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...confirmAuthHeader(), "idempotency-key": "horizon-down" },
      payload: { signedXdr: "SIGNED_XDR" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
  });
});
