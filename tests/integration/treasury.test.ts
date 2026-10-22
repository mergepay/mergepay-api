import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const prisma: any = {
    group: { findUnique: vi.fn() },
    groupMember: { findMany: vi.fn() },
    treasuryTxProposal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    treasurySignature: { create: vi.fn(), findMany: vi.fn() },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(prisma)),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { config } from "../../src/config";
import { stellar } from "../../src/services/stellar";
import {
  STATUS,
  treasurySignaturesService,
} from "../../src/services/treasury-signatures";

const treasury = Keypair.random();
const adminOne = Keypair.random();
const adminTwo = Keypair.random();
const nonAdmin = Keypair.random();
const destination = Keypair.random().publicKey();
const groupId = "integration-group";
const proposalId = "integration-proposal";

let storedProposal: any;
let storedSignatures: any[];

function unsignedXdr(memoCode = "INTEGRATION") {
  return stellar.buildPayment({
    sourcePublicKey: treasury.publicKey(),
    sourceSequence: "1",
    destination,
    asset: { code: "XLM", issuer: null },
    amount: "10",
    memoCode,
  });
}

function signedXdr(xdr: string, ...signers: Keypair[]) {
  const transaction = new Transaction(xdr, config.networkPassphrase);
  transaction.sign(...signers);
  return transaction.toXDR();
}

function proposalFrom(xdr: string) {
  return {
    id: proposalId,
    groupId,
    creatorId: "creator",
    xdr,
    txHash: new Transaction(xdr, config.networkPassphrase).hash().toString("hex"),
    sourceAccount: treasury.publicKey(),
    requiredWeight: 10,
    status: STATUS.pendingSignatures,
    stellarTxHash: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  storedSignatures = [];
  storedProposal = undefined;

  h.prisma.$transaction.mockImplementation(async (callback: (tx: any) => unknown) => callback(h.prisma));
  h.prisma.auditLog.create.mockResolvedValue({});
  h.prisma.treasurySignature.findMany.mockImplementation(async () => [...storedSignatures]);
  h.prisma.treasurySignature.create.mockImplementation(async ({ data }: any) => {
    const signature = { id: `signature-${storedSignatures.length + 1}`, ...data };
    storedSignatures.push(signature);
    return signature;
  });
  h.prisma.treasuryTxProposal.create.mockImplementation(async ({ data }: any) => {
    storedProposal = { id: proposalId, ...data };
    return storedProposal;
  });
  h.prisma.treasuryTxProposal.findUnique.mockImplementation(async () => storedProposal);
  h.prisma.treasuryTxProposal.update.mockImplementation(async ({ data }: any) => {
    storedProposal = { ...storedProposal, ...data };
    return storedProposal;
  });
  h.prisma.groupMember.findMany.mockResolvedValue([
    { userId: "admin-one", user: { stellarPublicKey: adminOne.publicKey() } },
    { userId: "admin-two", user: { stellarPublicKey: adminTwo.publicKey() } },
  ]);

  vi.spyOn(stellar, "loadAccount").mockResolvedValue({
    exists: true,
    sequence: "1",
    balances: [],
    signers: [
      { key: adminOne.publicKey(), weight: 5 },
      { key: adminTwo.publicKey(), weight: 5 },
      { key: nonAdmin.publicKey(), weight: 5 },
    ],
    thresholds: { low: 1, med: 5, high: 10 },
  });
  vi.spyOn(stellar, "submitSigned").mockResolvedValue("stellar-integration-hash");
});

describe("treasury multisig proposal integration", () => {
  it("creates a proposal from a real unsigned XDR and records its hash", async () => {
    const xdr = unsignedXdr();
    h.prisma.group.findUnique.mockResolvedValue({
      id: groupId,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
    });

    const result = await treasurySignaturesService.createProposal({
      groupId,
      creatorId: "creator",
      creatorPublicKey: adminOne.publicKey(),
      xdr,
    });

    expect(result.proposal.status).toBe(STATUS.pendingSignatures);
    expect(result.proposal.sourceAccount).toBe(treasury.publicKey());
    expect(result.proposal.requiredWeight).toBe(10);
    expect(result.proposal.txHash).toBe(
      new Transaction(xdr, config.networkPassphrase).hash().toString("hex")
    );
    expect(result.networkPassphrase).toBe(config.networkPassphrase);
  });

  it("rejects signed XDR and XDR from a different source account", async () => {
    h.prisma.group.findUnique.mockResolvedValue({
      id: groupId,
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasury.publicKey(),
    });

    await expect(
      treasurySignaturesService.createProposal({
        groupId,
        creatorId: "creator",
        creatorPublicKey: adminOne.publicKey(),
        xdr: signedXdr(unsignedXdr(), adminOne),
      })
    ).rejects.toMatchObject({ code: "XDR_NOT_UNSIGNED" });

    const otherSource = Keypair.random();
    const foreignXdr = stellar.buildPayment({
      sourcePublicKey: otherSource.publicKey(),
      sourceSequence: "1",
      destination,
      asset: { code: "XLM", issuer: null },
      amount: "10",
      memoCode: "FOREIGN",
    });

    await expect(
      treasurySignaturesService.createProposal({
        groupId,
        creatorId: "creator",
        creatorPublicKey: adminOne.publicKey(),
        xdr: foreignXdr,
      })
    ).rejects.toMatchObject({ code: "XDR_MISMATCH" });
  });

  it("rejects a valid signature from a non-admin member", async () => {
    const xdr = unsignedXdr();
    storedProposal = proposalFrom(xdr);

    await expect(
      treasurySignaturesService.submitSignature({
        proposalId,
        groupId,
        userId: "non-admin",
        signedXdr: signedXdr(xdr, nonAdmin),
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED_SIGNER" });

    expect(storedSignatures).toHaveLength(0);
    expect(stellar.submitSigned).not.toHaveBeenCalled();
  });

  it("collects authorized signatures and submits the assembled XDR at threshold", async () => {
    const xdr = unsignedXdr();
    storedProposal = proposalFrom(xdr);

    const first = await treasurySignaturesService.submitSignature({
      proposalId,
      groupId,
      userId: "admin-one",
      signedXdr: signedXdr(xdr, adminOne),
    });
    expect(first).toMatchObject({
      status: STATUS.pendingSignatures,
      totalWeight: 5,
      requiredWeight: 10,
      stellarTxHash: null,
    });

    const second = await treasurySignaturesService.submitSignature({
      proposalId,
      groupId,
      userId: "admin-two",
      signedXdr: signedXdr(xdr, adminTwo),
    });
    expect(second).toMatchObject({
      status: STATUS.submitted,
      totalWeight: 10,
      requiredWeight: 10,
      stellarTxHash: "stellar-integration-hash",
    });

    expect(stellar.submitSigned).toHaveBeenCalledTimes(1);
    const submitted = new Transaction(
      vi.mocked(stellar.submitSigned).mock.calls[0][0],
      config.networkPassphrase
    );
    expect(submitted.hash().toString("hex")).toBe(storedProposal.txHash);
    expect(submitted.signatures).toHaveLength(2);
  });
});
