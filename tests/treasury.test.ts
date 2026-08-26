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

  // Stateful fakes for treasuryProposal/treasurySignature: the proposal
  // signing flow reads its own prior writes (findUnique after create/update,
  // signatures accumulated via createMany), which a stateless mock can't
  // reproduce across a single request.
  const proposalState = { proposals: [] as any[], signatures: [] as any[], seq: 0 };
  const treasuryProposal = {
    create: vi.fn(async ({ data }: any) => {
      const row = {
        id: `prop_${++proposalState.seq}`,
        createdAt: new Date("2026-08-01T00:00:00.000Z"),
        updatedAt: new Date("2026-08-01T00:00:00.000Z"),
        failureReason: null,
        stellarTxHash: null,
        ...data,
      };
      proposalState.proposals.push(row);
      return { ...row };
    }),
    findUnique: vi.fn(async ({ where: { id }, include, select }: any) => {
      const row = proposalState.proposals.find((p) => p.id === id);
      if (!row) return null;
      if (select?.groupId) return { groupId: row.groupId };
      if (include?.signatures) {
        return { ...row, signatures: proposalState.signatures.filter((s) => s.proposalId === id) };
      }
      return { ...row };
    }),
    findMany: vi.fn(async ({ where }: any) =>
      proposalState.proposals
        .filter((p) => !where?.groupId || p.groupId === where.groupId)
        .map((row) => ({
          ...row,
          signatures: proposalState.signatures.filter((s) => s.proposalId === row.id),
        }))
    ),
    update: vi.fn(async ({ where: { id }, data }: any) => {
      const row = proposalState.proposals.find((p) => p.id === id);
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    }),
  };
  const treasurySignature = {
    createMany: vi.fn(async ({ data }: any) => {
      for (const d of data) {
        proposalState.signatures.push({ id: `sig_${++proposalState.seq}`, createdAt: new Date(), ...d });
      }
      return { count: data.length };
    }),
  };

  const prisma: any = {
    __proposalState: proposalState,
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal,
    treasurySignature,
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
  prisma.__proposalState.proposals.length = 0;
  prisma.__proposalState.signatures.length = 0;
  prisma.__proposalState.seq = 0;
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

// ---------------------------------------------------------------------------
// Multisig proposal + signature collection routes
// ---------------------------------------------------------------------------

const proposalAdminA = Keypair.random(); // on-chain weight 2
const proposalAdminB = Keypair.random(); // on-chain weight 1
const proposalTreasury = Keypair.random();

const proposalAdminAUser = {
  id: "prop_admin_a",
  stellarPublicKey: proposalAdminA.publicKey(),
  displayName: "Admin A",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};
const proposalAdminBUser = {
  id: "prop_admin_b",
  stellarPublicKey: proposalAdminB.publicKey(),
  displayName: "Admin B",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function fakeProposalGroup(over: Partial<any> = {}) {
  return {
    id: "group_2",
    name: "Proposals",
    treasuryEnabled: true,
    treasuryAccountPublicKey: proposalTreasury.publicKey(),
    treasuryRequiredSigners: 2,
    ...over,
  };
}

function fullWeightSnapshot(overrides: Partial<any> = {}) {
  return {
    exists: true,
    sequence: "200",
    balances: [],
    signers: [
      { key: proposalTreasury.publicKey(), weight: 0 },
      { key: proposalAdminA.publicKey(), weight: 2 },
      { key: proposalAdminB.publicKey(), weight: 1 },
    ],
    thresholds: { low: 1, med: 2, high: 2 },
    ...overrides,
  };
}

function mockAdminMembership(userId: string) {
  prisma.groupMember.findUnique.mockResolvedValueOnce({
    groupId: "group_2",
    userId,
    role: "admin",
  });
}

describe("POST /treasury/proposals", () => {
  it("lets a group admin create an unsigned multisig proposal", async () => {
    mockAdminMembership(proposalAdminAUser.id);
    prisma.group.findUnique.mockResolvedValue(fakeProposalGroup());
    loadAccountMock.mockResolvedValueOnce(fullWeightSnapshot());

    const res = await app.inject({
      method: "POST",
      url: "/treasury/proposals",
      headers: authHeader(proposalAdminAUser),
      payload: {
        groupId: "group_2",
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposal.status).toBe("PENDING_SIGNATURES");
    expect(body.proposal.threshold).toBe(2);
    expect(typeof body.xdr).toBe("string");
  });

  it("rejects non-admin members with 403", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_2",
      userId: "member_1",
      role: "member",
    });

    const res = await app.inject({
      method: "POST",
      url: "/treasury/proposals",
      headers: authHeader({ ...proposalAdminAUser, id: "member_1" }),
      payload: {
        groupId: "group_2",
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects a non-Stellar destination with 400", async () => {
    mockAdminMembership(proposalAdminAUser.id);

    const res = await app.inject({
      method: "POST",
      url: "/treasury/proposals",
      headers: authHeader(proposalAdminAUser),
      payload: { groupId: "group_2", destination: "not-a-key", amount: "5", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when treasury is not enabled", async () => {
    mockAdminMembership(proposalAdminAUser.id);
    prisma.group.findUnique.mockResolvedValue(fakeProposalGroup({ treasuryEnabled: false }));

    const res = await app.inject({
      method: "POST",
      url: "/treasury/proposals",
      headers: authHeader(proposalAdminAUser),
      payload: {
        groupId: "group_2",
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TREASURY_DISABLED");
  });
});

describe("POST /treasury/proposals/:id/signatures", () => {
  async function createProposal() {
    mockAdminMembership(proposalAdminAUser.id);
    prisma.group.findUnique.mockResolvedValue(fakeProposalGroup());
    loadAccountMock.mockResolvedValueOnce(fullWeightSnapshot());

    const res = await app.inject({
      method: "POST",
      url: "/treasury/proposals",
      headers: authHeader(proposalAdminAUser),
      payload: {
        groupId: "group_2",
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });
    return res.json().proposal.id as string;
  }

  it("accepts a valid admin signature and auto-submits once threshold weight is met", async () => {
    const proposalId = await createProposal();
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: proposalAdminAUser.id, groupId: "group_2", role: "admin", user: proposalAdminAUser },
      { userId: proposalAdminBUser.id, groupId: "group_2", role: "admin", user: proposalAdminBUser },
    ]);
    loadAccountMock.mockResolvedValueOnce(fullWeightSnapshot());
    mockAdminMembership(proposalAdminAUser.id);

    const stored = prisma.__proposalState.proposals.find((p: any) => p.id === proposalId);
    const signed = new Transaction(stored.xdr, config.networkPassphrase);
    signed.sign(proposalAdminA); // weight 2 meets threshold 2 alone

    const res = await app.inject({
      method: "POST",
      url: `/treasury/proposals/${proposalId}/signatures`,
      headers: authHeader(proposalAdminAUser),
      payload: { signedXdr: signed.toXDR() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("SUBMITTED");
    expect(body.signatureWeight).toBe(2);
    expect(body.stellarTxHash).toBe("hash_ok");
  });

  it("stays PENDING_SIGNATURES below threshold weight", async () => {
    const proposalId = await createProposal();
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: proposalAdminAUser.id, groupId: "group_2", role: "admin", user: proposalAdminAUser },
      { userId: proposalAdminBUser.id, groupId: "group_2", role: "admin", user: proposalAdminBUser },
    ]);
    loadAccountMock.mockResolvedValueOnce(fullWeightSnapshot());
    mockAdminMembership(proposalAdminBUser.id);

    const stored = prisma.__proposalState.proposals.find((p: any) => p.id === proposalId);
    const signed = new Transaction(stored.xdr, config.networkPassphrase);
    signed.sign(proposalAdminB); // weight 1, threshold 2

    const res = await app.inject({
      method: "POST",
      url: `/treasury/proposals/${proposalId}/signatures`,
      headers: authHeader(proposalAdminBUser),
      payload: { signedXdr: signed.toXDR() },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("PENDING_SIGNATURES");
    expect(body.stellarTxHash).toBeNull();
  });

  it("rejects a caller who isn't a group admin with 403", async () => {
    const proposalId = await createProposal();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_2",
      userId: "member_1",
      role: "member",
    });

    const res = await app.inject({
      method: "POST",
      url: `/treasury/proposals/${proposalId}/signatures`,
      headers: authHeader({ ...proposalAdminAUser, id: "member_1" }),
      payload: { signedXdr: "AAAA" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("rejects a signature from an account that isn't an authorized admin signer with 400", async () => {
    const proposalId = await createProposal();
    const stranger = Keypair.random();
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: proposalAdminAUser.id, groupId: "group_2", role: "admin", user: proposalAdminAUser },
    ]);
    loadAccountMock.mockResolvedValueOnce(fullWeightSnapshot());
    mockAdminMembership(proposalAdminAUser.id);

    const stored = prisma.__proposalState.proposals.find((p: any) => p.id === proposalId);
    const signed = new Transaction(stored.xdr, config.networkPassphrase);
    signed.sign(stranger);

    const res = await app.inject({
      method: "POST",
      url: `/treasury/proposals/${proposalId}/signatures`,
      headers: authHeader(proposalAdminAUser),
      payload: { signedXdr: signed.toXDR() },
    });

    expect(res.statusCode).toBe(400);
  });
});
