import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Transaction, Horizon } from "@stellar/stellar-sdk";

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
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

const { loadAccountMock } = vi.hoisted(() => ({ loadAccountMock: vi.fn() }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: loadAccountMock,
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { stellar, memoText } from "../src/services/stellar";
import { config } from "../src/config";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const admin = {
  id: "admin_1",
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "Admin",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function authHeader(user = admin) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

const signerA = Keypair.random();
const signerB = Keypair.random();
const treasuryAccount = Keypair.random();
const withdrawDestination = Keypair.random().publicKey();

function fakeTreasuryTx(over: Partial<any> = {}) {
  return {
    id: "ttx_1",
    shortCode: "WD1",
    groupId: "group_1",
    userId: admin.id,
    direction: "withdrawal",
    amount: "25.0000000",
    assetCode: "XLM",
    assetIssuer: null,
    destination: withdrawDestination,
    stellarTxHash: null,
    status: "awaiting_signatures",
    memo: memoText("WD1"),
    createdAt: new Date("2026-02-01T00:00:00.000Z"),
    ...over,
  };
}

function fakeGroup(over: Partial<any> = {}) {
  return {
    id: "group_1",
    name: "Trip",
    treasuryEnabled: true,
    treasuryAccountPublicKey: treasuryAccount.publicKey(),
    treasuryRequiredSigners: 2,
    ...over,
  };
}

function buildWithdrawalXdr(): string {
  const xdr = stellar.buildPayment({
    sourcePublicKey: treasuryAccount.publicKey(),
    sourceSequence: "100",
    destination: withdrawDestination,
    asset: { code: "XLM", issuer: null },
    amount: "25.0000000",
    memoCode: "WD1",
  });
  return xdr;
}

function sign(xdr: string, ...keys: Keypair[]): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(...keys);
  return tx.toXDR();
}

vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockResolvedValue({
  hash: "hash_ok",
} as any);

beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(Horizon.Server.prototype, "submitTransaction").mockResolvedValue({
    hash: "hash_ok",
  } as any);
  if (!app) app = await buildApp();
});

describe("POST /treasury-transactions/:id/confirm — multisig withdrawal", () => {
  it("submits once the configured threshold of on-chain signers has signed", async () => {
    const ttx = fakeTreasuryTx();
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "100",
      balances: [],
      signers: [
        { key: signerA.publicKey(), weight: 1 },
        { key: signerB.publicKey(), weight: 1 },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    });
    prisma.treasuryTransaction.update.mockResolvedValueOnce({
      ...ttx,
      status: "confirmed",
      stellarTxHash: "hash_ok",
      user: admin,
    });

    const signedXdr = sign(buildWithdrawalXdr(), signerA, signerB);

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.treasuryTransaction.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "confirmed" }),
      })
    );
  });

  it("rejects and marks failed when only one of two required signers has signed", async () => {
    const ttx = fakeTreasuryTx();
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "100",
      balances: [],
      signers: [
        { key: signerA.publicKey(), weight: 1 },
        { key: signerB.publicKey(), weight: 1 },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    });

    const signedXdr = sign(buildWithdrawalXdr(), signerA);

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(401);
    expect(prisma.treasuryTransaction.update).toHaveBeenCalledWith({
      where: { id: "ttx_1" },
      data: { status: "failed" },
    });
  });

  it("rejects a signature from an account outside the treasury's signer set", async () => {
    const ttx = fakeTreasuryTx();
    const outsider = Keypair.random();
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup({ treasuryRequiredSigners: 1 }));
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "100",
      balances: [],
      signers: [{ key: signerA.publicKey(), weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    });

    const signedXdr = sign(buildWithdrawalXdr(), outsider);

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(401);
  });

  it("rejects a withdrawal envelope with a tampered amount before touching Horizon", async () => {
    const ttx = fakeTreasuryTx({ amount: "25.0000000" });
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup({ treasuryRequiredSigners: 1 }));
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "100",
      balances: [],
      signers: [{ key: signerA.publicKey(), weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    });

    // Signed envelope for a different (larger) amount than the stored intent.
    const tamperedXdr = stellar.buildPayment({
      sourcePublicKey: treasuryAccount.publicKey(),
      sourceSequence: "100",
      destination: withdrawDestination,
      asset: { code: "XLM", issuer: null },
      amount: "999.0000000",
      memoCode: "WD1",
    });
    const signedXdr = sign(tamperedXdr, signerA);

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
  });

  it("rejects malformed XDR without updating status to confirmed", async () => {
    const ttx = fakeTreasuryTx();
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "100",
      balances: [],
      signers: [{ key: signerA.publicKey(), weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "not-a-real-envelope" },
    });

    expect(res.statusCode).toBe(400);
    expect(prisma.treasuryTransaction.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "confirmed" }) })
    );
  });

  it("rejects when the treasury account is unfunded", async () => {
    const ttx = fakeTreasuryTx();
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    loadAccountMock.mockResolvedValueOnce({
      exists: false,
      sequence: "0",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });

    const signedXdr = sign(buildWithdrawalXdr(), signerA, signerB);

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TREASURY_UNFUNDED");
  });

  it("only an admin can confirm a withdrawal", async () => {
    const ttx = fakeTreasuryTx();
    prisma.treasuryTransaction.findUnique.mockResolvedValue(ttx);
    prisma.group.findUnique.mockResolvedValueOnce(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: "member_1",
      role: "member",
    });

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader({ ...admin, id: "member_1" }),
      payload: { signedXdr: sign(buildWithdrawalXdr(), signerA, signerB) },
    });

    expect(res.statusCode).toBe(403);
  });
});

describe("POST /groups/:id/treasury/deposit — audit events", () => {
  it("writes an audit event when a deposit is created", async () => {
    prisma.group.findUnique.mockResolvedValue(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    const createdTx = {
      id: "ttx_dep_1",
      shortCode: "DP1",
      groupId: "group_1",
      userId: admin.id,
      direction: "deposit",
      amount: "10.0000000",
      assetCode: "XLM",
      assetIssuer: null,
      destination: treasuryAccount.publicKey(),
      status: "pending",
      memo: memoText("DP1"),
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
      user: admin,
    };
    prisma.treasuryTransaction.create.mockResolvedValueOnce(createdTx);
    prisma.auditLog.create.mockResolvedValueOnce({});
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "200",
      balances: [],
      signers: [{ key: admin.stellarPublicKey, weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/deposit",
      headers: authHeader(),
      payload: {
        amount: "10.0000000",
        assetCode: "XLM",
      },
    });

    if (res.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error("DEPOSIT AUDIT TEST ERROR:", res.statusCode, res.json());
    }
    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury.deposit.created",
          entityType: "treasury_transaction",
          entityId: "ttx_dep_1",
        }),
      })
    );
  });
});

describe("POST /groups/:id/treasury/withdraw — audit events", () => {
  it("writes an audit event when a withdrawal is created", async () => {
    prisma.group.findUnique.mockResolvedValue(fakeGroup());
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    const createdTx = {
      id: "ttx_wd_1",
      shortCode: "WD2",
      groupId: "group_1",
      userId: admin.id,
      direction: "withdrawal",
      amount: "15.0000000",
      assetCode: "XLM",
      assetIssuer: null,
      destination: withdrawDestination,
      status: "awaiting_signatures",
      memo: memoText("WD2"),
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
      createdAt: new Date("2026-08-25T00:00:00.000Z"),
      user: admin,
    };
    prisma.treasuryTransaction.create.mockResolvedValueOnce(createdTx);
    prisma.auditLog.create.mockResolvedValueOnce({});
    loadAccountMock.mockResolvedValueOnce({
      exists: true,
      sequence: "200",
      balances: [],
      signers: [
        { key: signerA.publicKey(), weight: 1 },
        { key: signerB.publicKey(), weight: 1 },
      ],
      thresholds: { low: 1, med: 2, high: 2 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/withdraw",
      headers: authHeader(),
      payload: {
        amount: "15.0000000",
        assetCode: "XLM",
        destination: withdrawDestination,
      },
    });

    if (res.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error("WITHDRAW AUDIT TEST ERROR:", res.statusCode, res.json());
    }
    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury.withdrawal.created",
          entityType: "treasury_transaction",
          entityId: "ttx_wd_1",
        }),
      })
    );
  });
});
