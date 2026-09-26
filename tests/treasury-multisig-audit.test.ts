import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Transaction, Networks, TransactionBuilder, Account } from "@stellar/stellar-sdk";

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
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: true,
        sequence: "123",
        balances: [],
        signers: [],
        thresholds: { low: 1, med: 2, high: 2 },
      })),
      buildPayment: vi.fn(() => validXdr as any),
      submitSigned: vi.fn(),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { AppError } from "../src/lib/errors";
import { config } from "../src/config";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const treasuryKeypair = Keypair.random();
const authKp = Keypair.random();

const fakeUser = () => ({
  id: "user_1",
  stellarPublicKey: authKp.publicKey(),
  displayName: "Tester",
});

function authHeader() {
  const user = fakeUser();
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) {
    app = await buildApp();
    app.setErrorHandler((error, request, reply) => {
      console.error("APP ERROR:", error);
      reply.status(500).send(error);
    });
  }
  
  prisma.group.findUnique.mockResolvedValue({
    id: "group_1",
    treasuryEnabled: true,
    treasuryAccountPublicKey: treasuryKeypair.publicKey(),
    treasuryRequiredSigners: 2,
  });
  prisma.groupMember.findFirst.mockResolvedValue({ role: "admin", userId: "user_1", groupId: "group_1" });
  prisma.groupMember.findUnique.mockResolvedValue({ role: "admin", userId: "user_1", groupId: "group_1" });
  prisma.groupMember.findMany.mockResolvedValue([
    { user: fakeUser() },
  ]);
});

const dummyAccount = new Account(Keypair.random().publicKey(), "123");
const validTx = new TransactionBuilder(dummyAccount, { fee: "100", networkPassphrase: config.networkPassphrase })
  .setTimeout(100)
  .build();
const validXdr = validTx.toXDR();

describe("Treasury Multisig Audit Logs", () => {
  it("writes an audit log when a proposal is created", async () => {
    prisma.treasuryProposal.create.mockResolvedValue({
      id: "prop_1",
      groupId: "group_1",
      creatorId: "user_1",
      xdr: validXdr,
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(),
      payload: {
        destination: Keypair.random().publicKey(),
        amount: "10",
        assetCode: "USDC",
      },
    });

    if (res.statusCode !== 200) console.error(res.json());
    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury.proposal.created",
          entityType: "treasury_proposal",
          entityId: "prop_1",
          userId: "user_1",
        }),
      })
    );
  });

  it("writes an audit log when a proposal is signed but not submitted", async () => {
    const tx = new Transaction(validXdr, config.networkPassphrase);
    tx.sign(authKp);
    
    prisma.treasuryProposal.findUnique.mockResolvedValue({
      id: "prop_1",
      groupId: "group_1",
      creatorId: "user_1",
      xdr: tx.toXDR(),
      threshold: 3, // 3 > 1, so it won't submit
      signatures: [],
      status: "awaiting_signatures",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.treasuryProposal.update.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(),
      payload: {
        signedXdr: tx.toXDR(),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury.proposal.signed",
          entityType: "treasury_proposal",
          entityId: "prop_1",
        }),
      })
    );
  });

  it("writes an audit log when a proposal is fully signed and submitted", async () => {
    const tx = new Transaction(validXdr, config.networkPassphrase);
    tx.sign(authKp);
    
    prisma.treasuryProposal.findUnique.mockResolvedValue({
      id: "prop_1",
      groupId: "group_1",
      creatorId: "user_1",
      xdr: tx.toXDR(),
      threshold: 1, // Will trigger submission
      signatures: [],
      status: "awaiting_signatures",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.treasuryProposal.update.mockResolvedValue({});
    
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockResolvedValueOnce("hash_xyz");

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(),
      payload: {
        signedXdr: tx.toXDR(),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury.proposal.submitted",
          entityType: "treasury_proposal",
          entityId: "prop_1",
        }),
      })
    );
  });

  it("writes an audit log when submission fails (rejected by Stellar)", async () => {
    const tx = new Transaction(validXdr, config.networkPassphrase);
    tx.sign(authKp);
    
    prisma.treasuryProposal.findUnique.mockResolvedValue({
      id: "prop_1",
      groupId: "group_1",
      creatorId: "user_1",
      xdr: tx.toXDR(),
      threshold: 1, // Will trigger submission
      signatures: [],
      status: "awaiting_signatures",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.treasuryProposal.update.mockResolvedValue({});
    
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitSigned).mockRejectedValueOnce(new Error("tx_bad_seq"));

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_1/sign",
      headers: authHeader(),
      payload: {
        signedXdr: tx.toXDR(),
      },
    });

    expect(res.statusCode).toBe(502); // upstream error
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury.proposal.failed",
          entityType: "treasury_proposal",
          entityId: "prop_1",
        }),
      })
    );
  });
});
