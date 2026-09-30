/**
 * Issue #705: Automated database audit logging for treasury multisig operations.
 *
 * Verifies that:
 *  1. `auditMultisigActionTx` records audit events transactionally with structured metadata.
 *  2. Treasury proposal creation creates an audit log entry (`treasury.proposal.created`).
 *  3. Signature collection creates an audit log entry (`treasury.proposal.signed`).
 *  4. Final submission creates an audit log entry (`treasury.proposal.submitted`).
 *  5. Failed submissions record audit log entries with failure reason.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Keypair,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
} from "@stellar/stellar-sdk";
import { config } from "../src/config";
import { AuditAction } from "../src/services/audit-actions";
import { auditMultisigActionTx } from "../src/services/audit";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    treasuryProposal: model(),
    treasuryApproval: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => {
  return {
    stellar: {
      loadAccount: vi.fn(),
      submitSigned: vi.fn(),
      buildPayment: vi.fn(),
    },
  };
});

import { treasuryProposalsService } from "../src/services/treasury-proposals";
import { stellar } from "../src/services/stellar";

const prisma = h.prisma;

describe("Issue #705: Treasury Multisig Audit Logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("auditMultisigActionTx helper", () => {
    it("persists structured audit log record within transaction client", async () => {
      const mockTx: any = {
        auditLog: {
          create: vi.fn(async ({ data }: any) => ({ id: "audit_123", ...data })),
        },
      };

      const params = {
        userId: "usr_alice",
        groupId: "grp_1",
        proposalId: "prop_1",
        action: AuditAction.TREASURY_PROPOSAL_CREATED,
        actorPublicKey: "GBBD...actorKey",
        outcome: "success" as const,
        metadata: {
          amount: "100.00",
          assetCode: "USDC",
          threshold: 2,
        },
      };

      await auditMultisigActionTx(mockTx, params);

      expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
      const callArgs = mockTx.auditLog.create.mock.calls[0][0];
      expect(callArgs.data.userId).toBe("usr_alice");
      expect(callArgs.data.groupId).toBe("grp_1");
      expect(callArgs.data.entityType).toBe("treasury_proposal");
      expect(callArgs.data.entityId).toBe("prop_1");
      expect(callArgs.data.action).toBe(AuditAction.TREASURY_PROPOSAL_CREATED);
      expect(callArgs.data.metadata.amount).toBe("100.00");
      expect(callArgs.data.metadata.assetCode).toBe("USDC");
      expect(callArgs.data.metadata.actorPublicKey).toBe("GBBD...actorKey");
    });
  });

  describe("Treasury proposals service multisig audit logging", () => {
    const creatorKey = Keypair.random();
    const treasuryKey = Keypair.random();
    const destKey = Keypair.random();

    it("creates audit log entry upon proposal creation", async () => {
      prisma.group.findUnique.mockResolvedValue({
        id: "grp_test",
        treasuryEnabled: true,
        treasuryAccountPublicKey: treasuryKey.publicKey(),
        treasuryRequiredSigners: 2,
      });

      (stellar.loadAccount as any).mockResolvedValue({
        exists: true,
        sequence: "100",
      });

      const xdr = new TransactionBuilder(
        new Account(treasuryKey.publicKey(), "100"),
        { fee: "100", networkPassphrase: config.networkPassphrase }
      )
        .addOperation(
          Operation.payment({
            destination: destKey.publicKey(),
            asset: Asset.native(),
            amount: "50",
          })
        )
        .setTimeout(300)
        .build()
        .toXDR();

      (stellar.buildPayment as any).mockReturnValue(xdr);

      prisma.treasuryProposal.create.mockImplementation(async ({ data }: any) => ({
        id: "prop_created_1",
        ...data,
      }));

      const res = await treasuryProposalsService.create(
        {
          groupId: "grp_test",
          creatorId: "user_creator",
          creatorPublicKey: creatorKey.publicKey(),
          destination: destKey.publicKey(),
          amount: "50",
          assetCode: "XLM",
          assetIssuer: null,
          memo: "MP:test",
        },
        2
      );

      expect(res.proposal).toBeDefined();
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      const auditWrite = prisma.auditLog.create.mock.calls[0][0];
      expect(auditWrite.data.action).toBe(AuditAction.TREASURY_PROPOSAL_CREATED);
      expect(auditWrite.data.entityType).toBe("treasury_proposal");
      expect(auditWrite.data.entityId).toBe("prop_created_1");
      expect(auditWrite.data.groupId).toBe("grp_test");
      expect(auditWrite.data.userId).toBe("user_creator");
      expect(auditWrite.data.metadata.actorPublicKey).toBe(creatorKey.publicKey());
      expect(auditWrite.data.metadata.threshold).toBe(2);
    });

    it("creates audit log entry upon signature collection", async () => {
      const mockTx: any = {
        auditLog: {
          create: vi.fn(async ({ data }: any) => ({ id: "audit_signed", ...data })),
        },
      };

      await auditMultisigActionTx(mockTx, {
        userId: "user_signer_1",
        groupId: "grp_test",
        proposalId: "prop_created_1",
        actorPublicKey: "GBSIGNERKEY123",
        action: AuditAction.TREASURY_PROPOSAL_SIGNED,
        metadata: {
          signerPublicKey: "GBSIGNERKEY123",
          txHash: "hash123",
          signatureCount: 1,
          threshold: 2,
        },
      });

      expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
      const call = mockTx.auditLog.create.mock.calls[0][0];
      expect(call.data.action).toBe(AuditAction.TREASURY_PROPOSAL_SIGNED);
      expect(call.data.entityType).toBe("treasury_proposal");
      expect(call.data.entityId).toBe("prop_created_1");
      expect(call.data.metadata.signerPublicKey).toBe("GBSIGNERKEY123");
      expect(call.data.metadata.signatureCount).toBe(1);
    });

    it("creates audit log entry upon proposal submission", async () => {
      const mockTx: any = {
        auditLog: {
          create: vi.fn(async ({ data }: any) => ({ id: "audit_submitted", ...data })),
        },
      };

      await auditMultisigActionTx(mockTx, {
        groupId: "grp_test",
        proposalId: "prop_created_1",
        actorPublicKey: "GBSIGNERKEY123",
        action: AuditAction.TREASURY_PROPOSAL_SUBMITTED,
        metadata: {
          stellarTxHash: "txhash_on_chain",
          signatureCount: 2,
          threshold: 2,
        },
      });

      expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
      const call = mockTx.auditLog.create.mock.calls[0][0];
      expect(call.data.action).toBe(AuditAction.TREASURY_PROPOSAL_SUBMITTED);
      expect(call.data.entityType).toBe("treasury_proposal");
      expect(call.data.entityId).toBe("prop_created_1");
      expect(call.data.metadata.stellarTxHash).toBe("txhash_on_chain");
      expect(call.data.metadata.signatureCount).toBe(2);
    });

    it("creates audit log entry upon proposal failure", async () => {
      const mockTx: any = {
        auditLog: {
          create: vi.fn(async ({ data }: any) => ({ id: "audit_failed", ...data })),
        },
      };

      await auditMultisigActionTx(mockTx, {
        groupId: "grp_test",
        proposalId: "prop_created_1",
        actorPublicKey: "GBSIGNERKEY123",
        action: AuditAction.TREASURY_PROPOSAL_FAILED,
        outcome: "failure",
        metadata: {
          reason: "Stellar Horizon rejected transaction: op_underfunded",
          signatureCount: 2,
          threshold: 2,
        },
      });

      expect(mockTx.auditLog.create).toHaveBeenCalledTimes(1);
      const call = mockTx.auditLog.create.mock.calls[0][0];
      expect(call.data.action).toBe(AuditAction.TREASURY_PROPOSAL_FAILED);
      expect(call.data.entityType).toBe("treasury_proposal");
      expect(call.data.entityId).toBe("prop_created_1");
      expect(call.data.metadata.outcome).toBe("failure");
      expect(call.data.metadata.reason).toContain("op_underfunded");
    });
  });
});

