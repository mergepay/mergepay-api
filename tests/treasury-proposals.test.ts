import {
  describe,
  it,
  expect,
  beforeEach,
  vi,
} from "vitest";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Memo,
} from "@stellar/stellar-sdk";

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
    treasuryProposal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
    },
    treasuryApproval: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: model(),
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
    submitSigned: vi.fn(),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
  toAsset: vi.fn(),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_" + Math.random().toString(36).slice(2, 8),
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "T",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

// All XDRs built/parsed in tests must use the SAME network passphrase the
// service uses (`config.networkPassphrase`). Otherwise the transaction hash
// differs between the test-side signer and the service-side verifier, and
// every signature fails verification with INVALID_SIGNATURE (400).
import { config } from "../src/config";
const NET = config.networkPassphrase;

/**
 * Build an unsigned, real, parseable payment XDR for tests.
 */
function makeUnsignedXdr(params: {
  source: Keypair;
  destination: string;
  amount: string;
  memo?: string;
}): string {
  return new TransactionBuilder(new Account(params.source.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: NET,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: Asset.native(),
        amount: params.amount,
      })
    )
    .addMemo(Memo.text(params.memo ?? `MP:${params.source.publicKey().slice(0, 6)}`))
    .setTimeout(300)
    .build()
    .toXDR();
}

/** Compute the tx hash of an unsigned XDR. */
function txHash(xdr: string): string {
  return new Transaction(xdr, NET).hash().toString("hex");
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  const { stellar } = await import("../src/services/stellar");
  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [
      { assetCode: "XLM", assetIssuer: null, balance: "1000.0000000" },
    ],
    signers: [{ key: "GA", weight: 1 }],
    thresholds: { low: 1, med: 1, high: 1 },
  });
});

// ---------------------------------------------------------------------------
// POST /groups/:groupId/treasury/proposals
// ---------------------------------------------------------------------------

describe("POST /groups/:groupId/treasury/proposals", () => {
  it("rejects non-admin members", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: {
        destination: Keypair.random().publicKey(),
        amount: "5",
        assetCode: "XLM",
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it("creates an unsigned proposal and returns it with txHash", async () => {
    const user = fakeUser();
    const treasury = Keypair.random();
    const dest = Keypair.random().publicKey();

    // Build a real XDR so the service can compute the txHash.
    const realXdr = makeUnsignedXdr({
      source: treasury,
      destination: dest,
      amount: "5",
    });

    const group = {
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: user.id,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
      treasuryRequiredSigners: 2,
      archived: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    };
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: group.id,
      userId: user.id,
      role: "admin",
    });
    prisma.group.findUnique.mockResolvedValue(group);
    const expectedHash = txHash(realXdr);
    prisma.treasuryProposal.create.mockResolvedValueOnce({
      id: "prop_1",
      groupId: group.id,
      creatorId: user.id,
      xdr: realXdr,
      txHash: expectedHash,
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      stellarTxHash: null,
      failureReason: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValueOnce({});
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.buildPayment).mockReturnValue(realXdr as any);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: {
        destination: dest,
        amount: "5",
        assetCode: "XLM",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposal.id).toBe("prop_1");
    expect(body.proposal.threshold).toBe(2);
    expect(body.xdr).toBe(realXdr);
    // Verify txHash was computed and stored
    expect(prisma.treasuryProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ txHash: expectedHash }),
      })
    );
  });

  it("rejects a non-Stellar destination", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "admin",
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: { destination: "not-a-key", amount: "5", assetCode: "XLM" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an invalid assetIssuer public key", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "admin",
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: {
        destination: Keypair.random().publicKey(),
        amount: "1",
        assetCode: "USDC",
        assetIssuer: "not-a-key",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_ASSET_ISSUER");
  });

  it("returns 400 when treasury is not enabled", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "admin",
    });
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
      payload: {
        destination: Keypair.random().publicKey(),
        amount: "1",
        assetCode: "XLM",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TREASURY_DISABLED");
  });
});

// ---------------------------------------------------------------------------
// GET /groups/:groupId/treasury/proposals
// ---------------------------------------------------------------------------

describe("GET /groups/:groupId/treasury/proposals", () => {
  it("returns the list with signature counts", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.treasuryProposal.findMany.mockResolvedValueOnce([
      {
        id: "prop_1",
        groupId: "group_1",
        creatorId: user.id,
        xdr: "AAAA",
        txHash: "abc123",
        threshold: 2,
        signatures: [
          { publicKey: "GAAA", signedAt: new Date().toISOString() },
          { publicKey: "GBBB", signedAt: new Date().toISOString() },
        ],
        status: "awaiting_signatures",
        stellarTxHash: null,
        failureReason: null,
        createdAt: new Date("2026-04-01T00:00:00.000Z"),
        updatedAt: new Date("2026-04-01T00:00:00.000Z"),
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].signatureCount).toBe(2);
    expect(body.proposals[0].threshold).toBe(2);
    expect(body.proposals[0].status).toBe("awaiting_signatures");
  });
});

// ---------------------------------------------------------------------------
// POST /groups/:groupId/treasury/proposals/:proposalId/sign
// ---------------------------------------------------------------------------

describe("POST /groups/:groupId/treasury/proposals/:proposalId/sign", () => {
  it("rejects signature submissions from non-members", async () => {
    const user = fakeUser({ id: "u_outsider" });
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);
    prisma.group.findUnique.mockResolvedValueOnce({ id: "group_1" });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: "AAAA" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns 409 ALREADY_SUBMITTED for a confirmed proposal", async () => {
    const user = fakeUser({ id: "u_insider" });
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: "u_other", user: { stellarPublicKey: Keypair.random().publicKey() } },
    ]);
    prisma.treasuryProposal.findUnique.mockResolvedValueOnce({
      id: "prop_1",
      groupId: "group_1",
      threshold: 1,
      signatures: [],
      status: "confirmed",
      xdr: "AAAA-confirmed",
      txHash: "abc123",
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: "AAAA" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("ALREADY_SUBMITTED");
  });

  it("rejects a proposal whose XDR hashes a different transaction", async () => {
    const user = fakeUser({ id: "u_signatory" });
    const treasury = Keypair.random();
    const signerKp = Keypair.random();

    // Build a real unsigned proposal XDR.
    const proposalXdr = makeUnsignedXdr({
      source: treasury,
      destination: Keypair.random().publicKey(),
      amount: "5",
      memo: "MP:AAAA",
    });

    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: "u_signer", user: { stellarPublicKey: signerKp.publicKey() } },
    ]);
    prisma.treasuryProposal.findUnique.mockResolvedValueOnce({
      id: "prop_1",
      groupId: "group_1",
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      xdr: proposalXdr,
      txHash: txHash(proposalXdr),
    });

    // Sign a DIFFERENT envelope so the hash won't match.
    const rogueSourceKp = Keypair.random();
    const rogue = new Transaction(
      makeUnsignedXdr({
        source: rogueSourceKp,
        destination: Keypair.random().publicKey(),
        amount: "999",
      }),
      NET
    );
    rogue.sign(rogueSourceKp);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: rogue.toXDR() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
  });

  it("returns the proposal when the signer is a member and meets threshold", async () => {
    const user = fakeUser({ id: "u_signatory" });
    const treasury = Keypair.random();

    // Single-key treasury so the treasury keypair itself can sign.
    const proposalXdr = makeUnsignedXdr({
      source: treasury,
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const proposalHash = txHash(proposalXdr);
    const pendingProposal = {
      id: "prop_1",
      groupId: "group_1",
      creatorId: "u_creator",
      xdr: proposalXdr,
      txHash: proposalHash,
      threshold: 1,
      signatures: [] as any[],
      status: "pending",
      stellarTxHash: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const finalProposal = {
      ...pendingProposal,
      signatures: [
        { publicKey: treasury.publicKey(), signedAt: new Date().toISOString() },
      ],
      status: "confirmed",
      stellarTxHash: "hash_xyz",
    };

    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: "u_treasury", user: { stellarPublicKey: treasury.publicKey() } },
    ]);
    prisma.treasuryApproval.findMany.mockResolvedValueOnce([]);

    // findUnique chain: (1) locked row in $transaction, (2) re-read in mergeAndSubmit, (3) route post-read
    prisma.treasuryProposal.findUnique
      .mockResolvedValueOnce(pendingProposal)
      .mockResolvedValueOnce(pendingProposal)
      .mockResolvedValueOnce(finalProposal);

    prisma.treasuryApproval.create.mockResolvedValueOnce({
      id: "approval_1",
      proposalId: "prop_1",
      userId: "u_treasury",
      txHash: proposalHash,
      signature: "sig",
      signedAt: new Date(),
      createdAt: new Date(),
    });

    const signed = new Transaction(proposalXdr, NET);
    signed.sign(treasury);

    prisma.treasuryProposal.update.mockResolvedValue(finalProposal);
    prisma.auditLog.create.mockResolvedValue({});

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockResolvedValueOnce("hash_xyz");

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: signed.toXDR() },
    });
    if (res.statusCode !== 200) {
      // eslint-disable-next-line no-console
      console.error("TEST DEBUG body:", res.body);
    }
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signatureCount).toBe(1);
    expect(body.threshold).toBe(1);
    expect(body.stellarTxHash).toBe("hash_xyz");
    expect(body.status).toBe("confirmed");
  });

  it("rejects duplicate approval from the same signer idempotently", async () => {
    const user = fakeUser({ id: "u_signatory" });
    const treasury = Keypair.random();

    const proposalXdr = makeUnsignedXdr({
      source: treasury,
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const proposalHash = txHash(proposalXdr);

    // Proposal with threshold 2, already has 1 signature from treasury.
    const pendingProposal = {
      id: "prop_1",
      groupId: "group_1",
      creatorId: "u_creator",
      xdr: proposalXdr,
      txHash: proposalHash,
      threshold: 2,
      signatures: [
        { publicKey: treasury.publicKey(), signedAt: new Date().toISOString() },
      ] as any[],
      status: "awaiting_signatures",
      stellarTxHash: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: "u_treasury", user: { stellarPublicKey: treasury.publicKey() } },
    ]);
    // Treasury has already approved.
    prisma.treasuryApproval.findMany.mockResolvedValueOnce([
      { userId: "u_treasury", txHash: proposalHash },
    ]);
    prisma.treasuryProposal.findUnique
      .mockResolvedValueOnce(pendingProposal)
      .mockResolvedValueOnce(pendingProposal);
    prisma.treasuryProposal.update.mockResolvedValueOnce(pendingProposal);

    // Sign with the same treasury key again (duplicate).
    const signed = new Transaction(proposalXdr, NET);
    signed.sign(treasury);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: signed.toXDR() },
    });
    // Should succeed (200) but not increase the approval count.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.signatureCount).toBe(1); // Still 1, not 2
    expect(body.status).toBe("awaiting_signatures");
  });

  it("rejects signature for a changed transaction intent", async () => {
    const user = fakeUser({ id: "u_signatory" });
    const treasury = Keypair.random();
    const signerKp = Keypair.random();

    const proposalXdr = makeUnsignedXdr({
      source: treasury,
      destination: Keypair.random().publicKey(),
      amount: "5",
      memo: "MP:ORIGINAL",
    });
    const proposalHash = txHash(proposalXdr);

    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.groupMember.findMany.mockResolvedValueOnce([
      { userId: "u_signer", user: { stellarPublicKey: signerKp.publicKey() } },
    ]);
    prisma.treasuryApproval.findMany.mockResolvedValueOnce([]);
    prisma.treasuryProposal.findUnique.mockResolvedValueOnce({
      id: "prop_1",
      groupId: "group_1",
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      xdr: proposalXdr,
      txHash: proposalHash,
    });

    // Build a modified XDR (different destination) and sign it.
    const modifiedXdr = makeUnsignedXdr({
      source: treasury,
      destination: Keypair.random().publicKey(), // Changed!
      amount: "5",
      memo: "MP:ORIGINAL",
    });
    const signed = new Transaction(modifiedXdr, NET);
    signed.sign(signerKp);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(user),
      payload: { signedXdr: signed.toXDR() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("XDR_MISMATCH");
  });
});

// ---------------------------------------------------------------------------
// GET /groups/:groupId/treasury/status
// ---------------------------------------------------------------------------

describe("GET /groups/:groupId/treasury/status", () => {
  it("returns treasury account snapshot for a member", async () => {
    const user = fakeUser();
    const treasury = Keypair.random().publicKey();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.group.findUnique.mockResolvedValueOnce({
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: user.id,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury,
      treasuryRequiredSigners: 2,
      archived: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/treasury/status",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.publicKey).toBe(treasury);
    expect(body.requiredSigners).toBe(2);
    expect(Array.isArray(body.signers)).toBe(true);
    expect(typeof body.networkPassphrase).toBe("string");
  });

  it("returns 400 when treasury is not enabled", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "member",
    });
    prisma.group.findUnique.mockResolvedValueOnce({
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: user.id,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1/treasury/status",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("TREASURY_DISABLED");
  });
});
