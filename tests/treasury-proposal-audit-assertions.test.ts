import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Memo,
  xdr,
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
    treasuryProposal: model(),
    treasuryApproval: model(),
    auditLog: model(),
    webhook: model(),
    webhookDelivery: model(),
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

import { treasuryProposalsService } from "../src/services/treasury-proposals";
import { config } from "../src/config";

const prisma = h.prisma;
const NET = config.networkPassphrase;

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

function txHash(xdr: string): string {
  return new Transaction(xdr, NET).hash().toString("hex");
}

function auditActions(): string[] {
  return prisma.auditLog.create.mock.calls.map(
    ([arg]: any[]) => arg.data.action
  );
}

const treasury = Keypair.random();
const creator = {
  id: "u_creator",
  publicKey: Keypair.random().publicKey(),
};

function createParams(over: Partial<any> = {}) {
  return {
    groupId: "group_1",
    creatorId: creator.id,
    creatorPublicKey: creator.publicKey,
    destination: Keypair.random().publicKey(),
    amount: "5",
    assetCode: "XLM",
    assetIssuer: null,
    memo: null,
    ...over,
  };
}

function mockEnabledTreasury() {
  prisma.group.findUnique.mockResolvedValue({
    id: "group_1",
    treasuryEnabled: true,
    treasuryAccountPublicKey: treasury.publicKey(),
    treasuryRequiredSigners: 2,
  });
}

function proposalRow(over: Partial<any> = {}) {
  const xdr = makeUnsignedXdr({
    source: treasury,
    destination: Keypair.random().publicKey(),
    amount: "5",
  });
  return {
    id: "prop_1",
    groupId: "group_1",
    creatorId: creator.id,
    xdr,
    txHash: txHash(xdr),
    threshold: 2,
    signatures: [] as any[],
    status: "awaiting_signatures",
    stellarTxHash: null,
    failureReason: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { stellar } = await import("../src/services/stellar");
  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [{ assetCode: "XLM", assetIssuer: null, balance: "1000.0000000" }],
    signers: [{ key: "GA", weight: 1 }],
    thresholds: { low: 1, med: 1, high: 1 },
  });
  vi.mocked(stellar.buildPayment).mockImplementation((intent: any) =>
    new TransactionBuilder(
      new Account(intent.sourcePublicKey, intent.sourceSequence ?? "1"),
      { fee: "100", networkPassphrase: NET }
    )
      .addOperation(
        Operation.payment({
          destination: intent.destination,
          asset:
            intent.asset?.code && intent.asset.code !== "XLM"
              ? new Asset(intent.asset.code, intent.asset.issuer)
              : Asset.native(),
          amount: intent.amount,
        })
      )
      .addMemo(Memo.text(intent.memoCode ?? "MP:TEST"))
      .setTimeout(300)
      .build()
      .toXDR()
  );
  prisma.auditLog.create.mockResolvedValue({});
});

describe("proposal creation audit records", () => {
  it("writes a created audit row atomically inside the creation transaction", async () => {
    mockEnabledTreasury();
    const row = proposalRow();
    prisma.treasuryProposal.create.mockResolvedValueOnce(row);

    await treasuryProposalsService.create(createParams(), 2);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "treasury.proposal.created",
        entityType: "treasury_proposal",
        entityId: "prop_1",
        groupId: "group_1",
        userId: creator.id,
        metadata: expect.objectContaining({
          outcome: "success",
          actorPublicKey: creator.publicKey,
          sourceAccount: treasury.publicKey(),
          txHash: row.txHash,
          threshold: 2,
        }),
      }),
    });

    const createOrder = prisma.treasuryProposal.create.mock.invocationCallOrder[0];
    const auditOrder = prisma.auditLog.create.mock.invocationCallOrder[0];
    expect(auditOrder).toBeGreaterThan(createOrder);
  });

  it("records a failure audit and no created row when the build fails", async () => {
    mockEnabledTreasury();
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockRejectedValueOnce(
      new Error("threshold cannot be satisfied")
    );

    await expect(treasuryProposalsService.create(createParams(), 2)).rejects.toThrow();

    expect(prisma.treasuryProposal.create).not.toHaveBeenCalled();
    expect(auditActions()).toEqual(["treasury.proposal.failed"]);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "treasury.proposal.failed",
        entityType: "treasury_proposal_build",
        groupId: "group_1",
        userId: creator.id,
        metadata: expect.objectContaining({ outcome: "failure" }),
      }),
    });
  });

  it("rolls back the creation when the audit write fails and records the failure", async () => {
    mockEnabledTreasury();
    prisma.treasuryProposal.create.mockResolvedValueOnce(proposalRow());
    prisma.auditLog.create
      .mockRejectedValueOnce(new Error("audit store down"))
      .mockResolvedValue({});

    await expect(treasuryProposalsService.create(createParams(), 2)).rejects.toThrow();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditActions()).toContain("treasury.proposal.failed");
    expect(prisma.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "treasury.proposal.failed",
        entityType: "treasury_proposal_build",
        metadata: expect.objectContaining({ outcome: "failure" }),
      }),
    });
  });

  it("writes no audit row when the treasury is disabled", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
    });

    await expect(treasuryProposalsService.create(createParams(), 2)).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("proposal signature audit records", () => {
  function setupSignable(threshold: number) {
    const row = proposalRow({
      threshold,
      status: threshold > 1 ? "awaiting_signatures" : "pending",
    });
    prisma.treasuryProposal.findUnique.mockResolvedValue(row);
    prisma.treasuryProposal.update.mockResolvedValue(row);
    prisma.treasuryApproval.findMany.mockResolvedValue([]);
    prisma.treasuryApproval.create.mockResolvedValue({ id: "approval_1" });
    prisma.groupMember.findMany.mockResolvedValue([
      { userId: "u_treasury", user: { stellarPublicKey: treasury.publicKey() } },
    ]);
    const signed = new Transaction(row.xdr, NET);
    signed.sign(treasury);
    return { row, signedXdr: signed.toXDR() };
  }

  function signArgs(signedXdr: string) {
    return {
      proposalId: "prop_1",
      groupId: "group_1",
      memberPublicKeys: [treasury.publicKey()],
      signedXdr,
      userId: "u_submitter",
      actorPublicKey: treasury.publicKey(),
    };
  }

  it("writes one signed audit row per new signature, bound to the tx hash", async () => {
    const { row, signedXdr } = setupSignable(2);

    const result = await treasuryProposalsService.submitSignatures(signArgs(signedXdr));
    expect(result.status).toBe("awaiting_signatures");

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(auditActions()).toEqual(["treasury.proposal.signed"]);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "treasury.proposal.signed",
        entityType: "treasury_proposal",
        entityId: "prop_1",
        groupId: "group_1",
        userId: "u_treasury",
        metadata: expect.objectContaining({
          outcome: "success",
          signerPublicKey: treasury.publicKey(),
          txHash: row.txHash,
          signatureCount: 1,
          threshold: 2,
        }),
      }),
    });
  });

  it("writes signed and submitted audit rows when the threshold is met", async () => {
    const { row, signedXdr } = setupSignable(1);
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockResolvedValueOnce("hash_xyz");

    const result = await treasuryProposalsService.submitSignatures(signArgs(signedXdr));
    expect(result.status).toBe("confirmed");

    expect(auditActions()).toEqual([
      "treasury.proposal.signed",
      "treasury.proposal.submitted",
    ]);
    expect(prisma.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        action: "treasury.proposal.submitted",
        entityType: "treasury_proposal",
        entityId: "prop_1",
        userId: "u_submitter",
        metadata: expect.objectContaining({
          outcome: "success",
          txHash: row.txHash,
          stellarTxHash: "hash_xyz",
          signatureCount: 1,
          threshold: 1,
        }),
      }),
    });
  });

  it("writes a failure audit and no submitted row when Stellar rejects the transaction", async () => {
    const { signedXdr } = setupSignable(1);
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockRejectedValueOnce(new Error("txFailed"));

    await expect(
      treasuryProposalsService.submitSignatures(signArgs(signedXdr))
    ).rejects.toThrow();

    expect(auditActions()).not.toContain("treasury.proposal.submitted");
    expect(auditActions()).toContain("treasury.proposal.failed");
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "treasury.proposal.failed",
        entityId: "prop_1",
        metadata: expect.objectContaining({
          outcome: "failure",
          reason: "txFailed",
        }),
      }),
    });
  });

  it("writes no audit row for a duplicate signature", async () => {
    const { row, signedXdr } = setupSignable(2);
    const alreadySigned = {
      ...row,
      signatures: [
        { publicKey: treasury.publicKey(), signedAt: new Date().toISOString() },
      ],
    };
    prisma.treasuryProposal.findUnique.mockResolvedValue(alreadySigned);
    prisma.treasuryApproval.findMany.mockResolvedValue([
      { userId: "u_treasury", txHash: row.txHash },
    ]);

    const result = await treasuryProposalsService.submitSignatures(signArgs(signedXdr));
    expect(result.signatureCount).toBe(1);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes no audit row when the XDR hashes a different transaction", async () => {
    setupSignable(2);
    const rogue = new Transaction(
      makeUnsignedXdr({
        source: Keypair.random(),
        destination: Keypair.random().publicKey(),
        amount: "999",
      }),
      NET
    );
    rogue.sign(Keypair.random());

    await expect(
      treasuryProposalsService.submitSignatures(signArgs(rogue.toXDR()))
    ).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.treasuryApproval.create).not.toHaveBeenCalled();
  });

  it("writes no audit row when the signature does not verify", async () => {
    const { row } = setupSignable(2);
    const forger = Keypair.random();
    prisma.groupMember.findMany.mockResolvedValue([
      { userId: "u_forger", user: { stellarPublicKey: forger.publicKey() } },
    ]);
    const tampered = new Transaction(row.xdr, NET);
    tampered.sign(forger);
    const forgedSig = tampered.signatures[0];
    const original = new Transaction(row.xdr, NET);
    original.addDecoratedSignature(
      new xdr.DecoratedSignature({
        hint: Keypair.fromPublicKey(treasury.publicKey()).signatureHint(),
        signature: forgedSig.signature(),
      })
    );

    await expect(
      treasuryProposalsService.submitSignatures(
        signArgs(original.toXDR())
      )
    ).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes no audit row for an expired proposal", async () => {
    const { row, signedXdr } = setupSignable(2);
    prisma.treasuryProposal.findUnique.mockResolvedValue({
      ...row,
      status: "expired",
    });

    await expect(
      treasuryProposalsService.submitSignatures(signArgs(signedXdr))
    ).rejects.toThrow();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rolls back signatures when the signed audit write fails", async () => {
    const { signedXdr } = setupSignable(2);
    prisma.auditLog.create.mockRejectedValueOnce(new Error("audit store down"));

    await expect(
      treasuryProposalsService.submitSignatures(signArgs(signedXdr))
    ).rejects.toThrow("audit store down");
  });
});
