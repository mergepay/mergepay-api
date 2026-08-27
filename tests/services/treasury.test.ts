/**
 * Unit tests for the treasury multisig proposal + signature collection
 * service (src/services/treasury.ts). Builds real payment XDRs with mock
 * Stellar keypairs so signature verification and weight math run against
 * genuine envelopes, not fixtures.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
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
  const state = { proposals: [] as any[], signatures: [] as any[], seq: 0 };

  const prisma: any = {
    __state: state,
    group: { findUnique: vi.fn() },
    groupMember: { findMany: vi.fn(async () => []) },
    treasuryProposal: {
      create: vi.fn(async ({ data }: any) => {
        const row = {
          id: `prop_${++state.seq}`,
          createdAt: new Date("2026-08-01T00:00:00.000Z"),
          updatedAt: new Date("2026-08-01T00:00:00.000Z"),
          failureReason: null,
          stellarTxHash: null,
          ...data,
        };
        state.proposals.push(row);
        return { ...row };
      }),
      findUnique: vi.fn(async ({ where: { id }, include }: any) => {
        const row = state.proposals.find((p) => p.id === id);
        if (!row) return null;
        if (include?.signatures) {
          return { ...row, signatures: state.signatures.filter((s) => s.proposalId === id) };
        }
        return { ...row };
      }),
      update: vi.fn(async ({ where: { id }, data }: any) => {
        const row = state.proposals.find((p) => p.id === id);
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      }),
    },
    treasurySignature: {
      createMany: vi.fn(async ({ data }: any) => {
        for (const d of data) {
          state.signatures.push({ id: `sig_${++state.seq}`, createdAt: new Date(), ...d });
        }
        return { count: data.length };
      }),
    },
    auditLog: { create: vi.fn(async () => ({})) },
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

const { loadAccountMock, submitSignedMock } = vi.hoisted(() => ({
  loadAccountMock: vi.fn(),
  submitSignedMock: vi.fn(),
}));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: loadAccountMock,
      submitSigned: submitSignedMock,
    },
  };
});

import { treasuryService, TreasuryProposalStatus } from "../../src/services/treasury";
import { config } from "../../src/config";

const NET = config.networkPassphrase;
const prisma = h.prisma;

const GROUP_ID = "group_1";
const treasury = Keypair.random();
const adminA = Keypair.random(); // on-chain weight 2
const adminB = Keypair.random(); // on-chain weight 1
const stranger = Keypair.random(); // not a group member at all
const destination = Keypair.random().publicKey();

const group = {
  id: GROUP_ID,
  treasuryEnabled: true,
  treasuryAccountPublicKey: treasury.publicKey(),
  treasuryRequiredSigners: 2,
};

const adminMembers = [
  { userId: "user_admin_a", groupId: GROUP_ID, role: "admin", user: { stellarPublicKey: adminA.publicKey() } },
  { userId: "user_admin_b", groupId: GROUP_ID, role: "admin", user: { stellarPublicKey: adminB.publicKey() } },
];

function fullWeightSnapshot(overrides: Partial<any> = {}) {
  return {
    exists: true,
    sequence: "100",
    balances: [],
    signers: [
      { key: treasury.publicKey(), weight: 0 },
      { key: adminA.publicKey(), weight: 2 },
      { key: adminB.publicKey(), weight: 1 },
    ],
    thresholds: { low: 1, med: 2, high: 2 },
    ...overrides,
  };
}

/** Sign a transaction hash and return just the resulting decorated signature. */
function decoratedSigFor(tx: Transaction, signer: Keypair) {
  const clone = new Transaction(tx.toXDR(), NET);
  clone.sign(signer);
  return clone.signatures[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.prisma.__state.proposals.length = 0;
  h.prisma.__state.signatures.length = 0;
  h.prisma.__state.seq = 0;
  prisma.group.findUnique.mockResolvedValue(group);
  prisma.groupMember.findMany.mockResolvedValue(adminMembers);
  loadAccountMock.mockResolvedValue(fullWeightSnapshot());
  submitSignedMock.mockResolvedValue("hash_final");
});

async function createTestProposal(threshold?: number) {
  const { proposal, xdr } = await treasuryService.createProposal({
    groupId: GROUP_ID,
    creatorId: "user_creator",
    destination,
    amount: "5",
    assetCode: "XLM",
    assetIssuer: null,
    memo: null,
  });
  if (threshold !== undefined) proposal.threshold = threshold;
  return { proposal, xdr };
}

describe("treasuryService.createProposal", () => {
  it("builds an unsigned XDR and captures the on-chain threshold weight", async () => {
    const { proposal, xdr } = await createTestProposal();

    expect(proposal.status).toBe(TreasuryProposalStatus.PENDING_SIGNATURES);
    expect(proposal.threshold).toBe(2); // snapshot.thresholds.high
    expect(typeof xdr).toBe("string");

    // The stored envelope must be unsigned and parse back to the same tx.
    const parsed = new Transaction(xdr, NET);
    expect(parsed.signatures).toHaveLength(0);
    expect(parsed.operations[0].type).toBe("payment");
  });

  it("rejects when treasury is not enabled", async () => {
    prisma.group.findUnique.mockResolvedValueOnce({ ...group, treasuryEnabled: false });
    await expect(
      treasuryService.createProposal({
        groupId: GROUP_ID,
        creatorId: "user_creator",
        destination,
        amount: "5",
        assetCode: "XLM",
        assetIssuer: null,
        memo: null,
      })
    ).rejects.toMatchObject({ status: 400, code: "TREASURY_DISABLED" });
  });
});

describe("treasuryService.submitSignatures", () => {
  it("collects a valid admin signature below threshold without submitting", async () => {
    const { proposal, xdr } = await createTestProposal();
    const baseTx = new Transaction(xdr, NET);
    const signed = new Transaction(xdr, NET);
    signed.sign(adminB); // weight 1, threshold 2

    const result = await treasuryService.submitSignatures({
      proposalId: proposal.id,
      groupId: GROUP_ID,
      submittedByUserId: "user_admin_b",
      signedXdr: signed.toXDR(),
    });

    expect(result.status).toBe(TreasuryProposalStatus.PENDING_SIGNATURES);
    expect(result.signatureWeight).toBe(1);
    expect(result.stellarTxHash).toBeNull();
    expect(submitSignedMock).not.toHaveBeenCalled();
  });

  it("auto-submits to Horizon once the collected weight reaches the threshold", async () => {
    const { proposal, xdr } = await createTestProposal();
    const signed = new Transaction(xdr, NET);
    signed.sign(adminA); // weight 2 meets threshold 2 alone

    const result = await treasuryService.submitSignatures({
      proposalId: proposal.id,
      groupId: GROUP_ID,
      submittedByUserId: "user_admin_a",
      signedXdr: signed.toXDR(),
    });

    expect(result.status).toBe(TreasuryProposalStatus.SUBMITTED);
    expect(result.signatureWeight).toBe(2);
    expect(result.stellarTxHash).toBe("hash_final");
    expect(submitSignedMock).toHaveBeenCalledTimes(1);

    const stored = h.prisma.__state.proposals.find((p) => p.id === proposal.id);
    expect(stored.status).toBe(TreasuryProposalStatus.SUBMITTED);
    expect(stored.stellarTxHash).toBe("hash_final");
  });

  it("accumulates weight across two separate admin signature submissions", async () => {
    const { proposal, xdr } = await createTestProposal();

    const firstSigned = new Transaction(xdr, NET);
    firstSigned.sign(adminB);
    const first = await treasuryService.submitSignatures({
      proposalId: proposal.id,
      groupId: GROUP_ID,
      submittedByUserId: "user_admin_b",
      signedXdr: firstSigned.toXDR(),
    });
    expect(first.status).toBe(TreasuryProposalStatus.PENDING_SIGNATURES);

    const secondSigned = new Transaction(xdr, NET);
    secondSigned.sign(adminA);
    const second = await treasuryService.submitSignatures({
      proposalId: proposal.id,
      groupId: GROUP_ID,
      submittedByUserId: "user_admin_a",
      signedXdr: secondSigned.toXDR(),
    });

    expect(second.signatureWeight).toBe(3);
    expect(second.status).toBe(TreasuryProposalStatus.SUBMITTED);
  });

  it("rejects a signature from an account that isn't a group signer at all (400)", async () => {
    const { proposal, xdr } = await createTestProposal();
    const signed = new Transaction(xdr, NET);
    signed.sign(stranger);

    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_a",
        signedXdr: signed.toXDR(),
      })
    ).rejects.toMatchObject({ status: 400, code: "NO_NEW_SIGNATURES" });
  });

  it("rejects a signature from an admin whose on-chain weight has been revoked (400)", async () => {
    const { proposal, xdr } = await createTestProposal();
    // adminB is still a group admin, but Horizon now shows weight 0.
    loadAccountMock.mockResolvedValue(
      fullWeightSnapshot({
        signers: [
          { key: treasury.publicKey(), weight: 0 },
          { key: adminA.publicKey(), weight: 2 },
          { key: adminB.publicKey(), weight: 0 },
        ],
      })
    );
    const signed = new Transaction(xdr, NET);
    signed.sign(adminB);

    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_b",
        signedXdr: signed.toXDR(),
      })
    ).rejects.toMatchObject({ status: 400, code: "UNAUTHORIZED_SIGNER" });
  });

  it("rejects a tampered signature that carries a valid admin's hint but doesn't verify (400)", async () => {
    const { proposal, xdr } = await createTestProposal();
    const baseTx = new Transaction(xdr, NET);

    // A different envelope (different destination => different hash), signed
    // by the same admin. The signature is valid for THAT hash, not this one.
    const rogueTx = new TransactionBuilder(new Account(treasury.publicKey(), "100"), {
      fee: "200",
      networkPassphrase: NET,
    })
      .addOperation(
        Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "999" })
      )
      .addMemo(Memo.text("MP:ROGUE"))
      .setTimeout(300)
      .build();
    const rogueSig = decoratedSigFor(rogueTx, adminA);

    const tampered = new Transaction(xdr, NET);
    tampered.addDecoratedSignature(rogueSig);

    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_a",
        signedXdr: tampered.toXDR(),
      })
    ).rejects.toMatchObject({ status: 400, code: "INVALID_SIGNATURE" });
  });

  it("rejects a duplicate signature from the same admin (409)", async () => {
    const { proposal, xdr } = await createTestProposal();
    const signed = new Transaction(xdr, NET);
    signed.sign(adminB);

    await treasuryService.submitSignatures({
      proposalId: proposal.id,
      groupId: GROUP_ID,
      submittedByUserId: "user_admin_b",
      signedXdr: signed.toXDR(),
    });

    const signedAgain = new Transaction(xdr, NET);
    signedAgain.sign(adminB);
    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_b",
        signedXdr: signedAgain.toXDR(),
      })
    ).rejects.toMatchObject({ status: 409, code: "DUPLICATE_SIGNATURE" });
  });

  it("rejects an XDR that hashes a different transaction than the proposal (400)", async () => {
    const { proposal } = await createTestProposal();
    const other = new TransactionBuilder(new Account(treasury.publicKey(), "100"), {
      fee: "200",
      networkPassphrase: NET,
    })
      .addOperation(
        Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" })
      )
      .addMemo(Memo.text("MP:OTHER"))
      .setTimeout(300)
      .build();
    other.sign(adminA);

    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_a",
        signedXdr: other.toXDR(),
      })
    ).rejects.toMatchObject({ status: 400, code: "XDR_MISMATCH" });
  });

  it("marks the proposal FAILED when Horizon rejects the submission", async () => {
    submitSignedMock.mockRejectedValueOnce(new Error("tx_bad_seq"));
    const { proposal, xdr } = await createTestProposal();
    const signed = new Transaction(xdr, NET);
    signed.sign(adminA);

    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_a",
        signedXdr: signed.toXDR(),
      })
    ).rejects.toMatchObject({ status: 502 });

    const stored = h.prisma.__state.proposals.find((p) => p.id === proposal.id);
    expect(stored.status).toBe(TreasuryProposalStatus.FAILED);
    expect(stored.failureReason).toContain("tx_bad_seq");
  });

  it("rejects new signatures once the proposal is already submitted (409)", async () => {
    const { proposal, xdr } = await createTestProposal();
    const first = new Transaction(xdr, NET);
    first.sign(adminA);
    await treasuryService.submitSignatures({
      proposalId: proposal.id,
      groupId: GROUP_ID,
      submittedByUserId: "user_admin_a",
      signedXdr: first.toXDR(),
    });

    const second = new Transaction(xdr, NET);
    second.sign(adminB);
    await expect(
      treasuryService.submitSignatures({
        proposalId: proposal.id,
        groupId: GROUP_ID,
        submittedByUserId: "user_admin_b",
        signedXdr: second.toXDR(),
      })
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_SUBMITTED" });
  });
});
