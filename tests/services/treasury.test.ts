/**
 * Treasury signature-collector service (src/services/treasury-signatures.ts).
 *
 * Builds a real unsigned payment XDR with mock Stellar keypairs and drives
 * `createProposal` / `submitSignature` directly against a mocked Prisma
 * client, so every signature verification and weight-threshold decision runs
 * through the real `@stellar/stellar-sdk` cryptography rather than a stub.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Transaction, xdr } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const prisma: any = {
    group: { findUnique: vi.fn() },
    groupMember: { findMany: vi.fn() },
    treasuryTxProposal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    treasurySignature: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { prisma } from "../../src/db";
import { config } from "../../src/config";
import { stellar } from "../../src/services/stellar";
import { AppError } from "../../src/errors";
import {
  treasurySignaturesService,
  STATUS,
} from "../../src/services/treasury-signatures";

const treasury = Keypair.random();
const admin1 = Keypair.random();
const admin2 = Keypair.random();
const nonAdminSigner = Keypair.random();
const destination = Keypair.random().publicKey();

/** Build a real unsigned payment XDR sourced from an arbitrary key. */
function buildXdr(sourcePublicKey: string, memoCode = "TXPROP1"): string {
  return stellar.buildPayment({
    sourcePublicKey,
    sourceSequence: "1",
    destination,
    asset: { code: "XLM", issuer: null },
    amount: "10.0000000",
    memoCode,
  });
}

/** Clone an XDR and sign it with the given keypairs, returning the signed XDR. */
function sign(xdr: string, ...keys: Keypair[]): string {
  const clone = new Transaction(xdr, config.networkPassphrase);
  clone.sign(...keys);
  return clone.toXDR();
}

const GROUP_ID = "group_1";
const PROPOSAL_ID = "proposal_1";

/** In-memory stand-ins for the two tables the service touches, reset per test. */
let storedProposal: any;
let storedSignatures: any[];

function setupProposal(overrides: Record<string, any> = {}) {
  const xdr = buildXdr(treasury.publicKey());
  const txHash = new Transaction(xdr, config.networkPassphrase).hash().toString("hex");
  storedProposal = {
    id: PROPOSAL_ID,
    groupId: GROUP_ID,
    creatorId: "creator_1",
    xdr,
    txHash,
    sourceAccount: treasury.publicKey(),
    requiredWeight: 10,
    status: STATUS.pendingSignatures,
    stellarTxHash: null,
    failureReason: null,
    ...overrides,
  };
  return storedProposal;
}

beforeEach(() => {
  vi.clearAllMocks();
  storedSignatures = [];

  (prisma.treasuryTxProposal.findUnique as any).mockImplementation(async ({ where }: any) =>
    storedProposal && where.id === storedProposal.id ? { ...storedProposal } : null
  );
  (prisma.treasuryTxProposal.update as any).mockImplementation(async ({ data }: any) => {
    storedProposal = { ...storedProposal, ...data };
    return storedProposal;
  });
  (prisma.treasuryTxProposal.create as any).mockImplementation(async ({ data }: any) => {
    storedProposal = { id: PROPOSAL_ID, ...data };
    return storedProposal;
  });
  (prisma.treasurySignature.findMany as any).mockImplementation(async ({ where }: any) =>
    storedSignatures.filter((s) => s.proposalId === where.proposalId)
  );
  (prisma.treasurySignature.create as any).mockImplementation(async ({ data }: any) => {
    const row = { id: `sig_${storedSignatures.length + 1}`, createdAt: new Date(), ...data };
    storedSignatures.push(row);
    return row;
  });
  (prisma.groupMember.findMany as any).mockResolvedValue([
    { userId: "admin1", user: { stellarPublicKey: admin1.publicKey() } },
    { userId: "admin2", user: { stellarPublicKey: admin2.publicKey() } },
  ]);
  (prisma.auditLog.create as any).mockResolvedValue({});

  vi.spyOn(stellar, "loadAccount").mockResolvedValue({
    exists: true,
    sequence: "1",
    balances: [],
    signers: [
      { key: admin1.publicKey(), weight: 5 },
      { key: admin2.publicKey(), weight: 6 },
      { key: nonAdminSigner.publicKey(), weight: 4 },
    ],
    thresholds: { low: 1, med: 5, high: 10 },
  } as any);
  vi.spyOn(stellar, "submitSigned").mockResolvedValue("stellar_hash_1");
});

describe("treasurySignaturesService.createProposal", () => {
  it("stores a pending proposal from an unsigned XDR", async () => {
    (prisma.group.findUnique as any).mockResolvedValue({
      id: GROUP_ID,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
    });
    const xdr = buildXdr(treasury.publicKey());

    const { proposal } = await treasurySignaturesService.createProposal({
      groupId: GROUP_ID,
      creatorId: "creator_1",
      xdr,
    });

    expect(proposal.status).toBe(STATUS.pendingSignatures);
    expect(proposal.sourceAccount).toBe(treasury.publicKey());
    expect(proposal.requiredWeight).toBe(10);
    expect(proposal.txHash).toBe(
      new Transaction(xdr, config.networkPassphrase).hash().toString("hex")
    );
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });

  it("rejects when the treasury is not enabled", async () => {
    (prisma.group.findUnique as any).mockResolvedValue({
      id: GROUP_ID,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
    });

    await expect(
      treasurySignaturesService.createProposal({
        groupId: GROUP_ID,
        creatorId: "creator_1",
        xdr: buildXdr(treasury.publicKey()),
      })
    ).rejects.toMatchObject({ status: 400, code: "TREASURY_DISABLED" });
  });

  it("rejects an XDR whose source is not the group's treasury account", async () => {
    (prisma.group.findUnique as any).mockResolvedValue({
      id: GROUP_ID,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
    });
    const wrongSource = Keypair.random().publicKey();

    await expect(
      treasurySignaturesService.createProposal({
        groupId: GROUP_ID,
        creatorId: "creator_1",
        xdr: buildXdr(wrongSource),
      })
    ).rejects.toMatchObject({ status: 400, code: "XDR_MISMATCH" });
  });

  it("rejects an XDR that already carries a signature", async () => {
    (prisma.group.findUnique as any).mockResolvedValue({
      id: GROUP_ID,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
    });
    const signedXdr = sign(buildXdr(treasury.publicKey()), admin1);

    await expect(
      treasurySignaturesService.createProposal({
        groupId: GROUP_ID,
        creatorId: "creator_1",
        xdr: signedXdr,
      })
    ).rejects.toMatchObject({ status: 400, code: "XDR_NOT_UNSIGNED" });
  });
});

describe("treasurySignaturesService.submitSignature", () => {
  it("stores a below-threshold signature without submitting", async () => {
    setupProposal();
    const signedXdr = sign(storedProposal.xdr, admin1);

    const result = await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin1",
      signedXdr,
    });

    expect(result).toMatchObject({
      status: STATUS.pendingSignatures,
      totalWeight: 5,
      requiredWeight: 10,
      stellarTxHash: null,
    });
    expect(stellar.submitSigned).not.toHaveBeenCalled();
    expect(storedSignatures).toHaveLength(1);
  });

  it("merges signatures and submits once the weight threshold is met", async () => {
    setupProposal();
    await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin1",
      signedXdr: sign(storedProposal.xdr, admin1),
    });

    const result = await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin2",
      signedXdr: sign(storedProposal.xdr, admin2),
    });

    expect(result).toMatchObject({
      status: STATUS.submitted,
      totalWeight: 11,
      requiredWeight: 10,
      stellarTxHash: "stellar_hash_1",
    });
    expect(storedProposal.status).toBe(STATUS.submitted);
    expect(stellar.submitSigned).toHaveBeenCalledTimes(1);

    const merged = new Transaction(
      (stellar.submitSigned as any).mock.calls[0][0],
      config.networkPassphrase
    );
    expect(merged.signatures).toHaveLength(2);
  });

  it("is idempotent when the same signer resubmits", async () => {
    setupProposal();
    const signedXdr = sign(storedProposal.xdr, admin1);
    await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin1",
      signedXdr,
    });
    const result = await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin1",
      signedXdr,
    });

    expect(result.totalWeight).toBe(5);
    expect(storedSignatures).toHaveLength(1);
  });

  it("rejects a valid signature from a non-admin account with 400", async () => {
    setupProposal();
    // nonAdminSigner carries real on-chain weight, but is not returned by the
    // group-admin membership lookup, so it must never contribute weight.
    const signedXdr = sign(storedProposal.xdr, nonAdminSigner);

    await expect(
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "non_admin",
        signedXdr,
      })
    ).rejects.toMatchObject({ status: 400, code: "UNAUTHORIZED_SIGNER" });
    expect(storedSignatures).toHaveLength(0);
  });

  it("rejects a cryptographically invalid signature with 400", async () => {
    setupProposal();
    // A byte-valid signature from an authorized admin key, but computed over
    // a different transaction — the hint matches, the bytes don't verify.
    const otherTx = new Transaction(
      buildXdr(treasury.publicKey(), "OTHERTX1"),
      config.networkPassphrase
    );
    const wrongSignature = admin1.sign(otherTx.hash());

    // `Transaction.addSignature` verifies before attaching, so a genuinely
    // invalid signature has to be attached via the raw decorated-signature
    // API instead — exactly what a malicious or buggy client could send.
    const tampered = new Transaction(storedProposal.xdr, config.networkPassphrase);
    tampered.addDecoratedSignature(
      new xdr.DecoratedSignature({
        hint: admin1.signatureHint(),
        signature: wrongSignature,
      })
    );

    await expect(
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "admin1",
        signedXdr: tampered.toXDR(),
      })
    ).rejects.toMatchObject({ status: 400, code: "INVALID_SIGNATURE" });
    expect(storedSignatures).toHaveLength(0);
  });

  it("rejects a signed XDR for a different transaction than the proposal", async () => {
    setupProposal();
    const differentXdr = buildXdr(treasury.publicKey(), "DIFFERENT1");
    const signedXdr = sign(differentXdr, admin1);

    await expect(
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "admin1",
        signedXdr,
      })
    ).rejects.toMatchObject({ status: 400, code: "XDR_MISMATCH" });
    expect(storedSignatures).toHaveLength(0);
  });

  it("rejects new signatures once the proposal has already been submitted", async () => {
    setupProposal({ status: STATUS.submitted });

    await expect(
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "admin1",
        signedXdr: sign(storedProposal.xdr, admin1),
      })
    ).rejects.toMatchObject({ status: 409, code: "ALREADY_SUBMITTED" });
  });

  it("marks the proposal FAILED when Horizon rejects the submission", async () => {
    setupProposal();
    (stellar.submitSigned as any).mockRejectedValue(new Error("tx_bad_seq"));

    await treasurySignaturesService.submitSignature({
      proposalId: PROPOSAL_ID,
      groupId: GROUP_ID,
      userId: "admin1",
      signedXdr: sign(storedProposal.xdr, admin1),
    });
    await expect(
      treasurySignaturesService.submitSignature({
        proposalId: PROPOSAL_ID,
        groupId: GROUP_ID,
        userId: "admin2",
        signedXdr: sign(storedProposal.xdr, admin2),
      })
    ).rejects.toBeInstanceOf(AppError);

    expect(storedProposal.status).toBe(STATUS.failed);
    expect(storedProposal.failureReason).toContain("tx_bad_seq");
  });
});
