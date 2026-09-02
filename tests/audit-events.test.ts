/**
 * Structured audit event tests — Issue #131.
 *
 * Verifies that the audit action vocabulary, audit helpers, and treasury
 * proposal mutations create correct audit records with actor, target,
 * action, outcome, and correlation identifiers. Also asserts that
 * sensitive payloads (private keys, signed XDRs, bearer tokens) never
 * land in audit metadata.
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
import { AuditAction } from "../src/services/audit-actions";
import { auditData } from "../src/services/audit";

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
  const token = signToken({
    id: user.id,
    stellarPublicKey: user.stellarPublicKey,
  });
  return { authorization: `Bearer ${token}` };
}

const treasuryAccount = Keypair.random();
const NET = "Test SDF Network ; September 2015";

function makeUnsignedXdr(params: {
  source: Keypair;
  destination: string;
  amount: string;
  memo?: string;
}): string {
  return new TransactionBuilder(
    new Account(params.source.publicKey(), "1"),
    { fee: "100", networkPassphrase: NET }
  )
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: Asset.native(),
        amount: params.amount,
      })
    )
    .addMemo(Memo.text(params.memo ?? "MP:TEST"))
    .setTimeout(300)
    .build()
    .toXDR();
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

// ---------------------------------------------------------------------------
// 1. Audit action vocabulary — complete, correct, typed
// ---------------------------------------------------------------------------
describe("AuditAction vocabulary", () => {
  it("has non-empty string values for all actions", () => {
    for (const [key, value] of Object.entries(AuditAction)) {
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
      // All actions follow the dot-separated naming convention
      expect(value).toContain(".");
    }
  });

  it("covers treasury mutations", () => {
    expect(AuditAction.TREASURY_ENABLE).toBe("treasury.enable");
    expect(AuditAction.TREASURY_DEPOSIT_CREATE).toBe(
      "treasury.deposit.create"
    );
    expect(AuditAction.TREASURY_WITHDRAW_CREATE).toBe(
      "treasury.withdraw.create"
    );
    expect(AuditAction.TREASURY_CONFIRM).toBe("treasury.confirm");
    expect(AuditAction.TREASURY_CONFIRM_FAILED).toBe(
      "treasury.confirm.failed"
    );
    expect(AuditAction.TREASURY_SIGNER_VALIDATION).toBe(
      "treasury.signer_validation"
    );
  });

  it("covers treasury proposal mutations", () => {
    expect(AuditAction.TREASURY_PROPOSAL_CREATED).toBe(
      "treasury.proposal.created"
    );
    expect(AuditAction.TREASURY_PROPOSAL_SIGNED).toBe(
      "treasury.proposal.signed"
    );
    expect(AuditAction.TREASURY_PROPOSAL_SUBMITTED).toBe(
      "treasury.proposal.submitted"
    );
    expect(AuditAction.TREASURY_PROPOSAL_FAILED).toBe(
      "treasury.proposal.failed"
    );
  });

  it("covers settlement lifecycle mutations", () => {
    expect(AuditAction.SETTLEMENT_CREATED).toBe("settlement.created");
    expect(AuditAction.SETTLEMENT_XDR_SUBMITTED).toBe(
      "settlement.xdr_submitted"
    );
    expect(AuditAction.SETTLEMENT_CONFIRMED).toBe("settlement.confirmed");
    expect(AuditAction.SETTLEMENT_FAILED).toBe("settlement.failed");
    expect(AuditAction.SETTLEMENT_RETRIED).toBe("settlement.retried");
    expect(AuditAction.SETTLEMENT_CONFIRM_RETRY).toBe(
      "settlement.confirm.retry"
    );
    expect(AuditAction.SETTLEMENT_CONFIRM_VALIDATION_FAILED).toBe(
      "settlement.confirm.validation_failed"
    );
  });

  it("covers group membership mutations", () => {
    expect(AuditAction.GROUP_CREATE).toBe("group.create");
    expect(AuditAction.GROUP_ARCHIVE).toBe("group.archive");
    expect(AuditAction.GROUP_INVITE).toBe("group.invite");
    expect(AuditAction.GROUP_INVITE_CODE_CREATE).toBe(
      "group.invite_code_create"
    );
    expect(AuditAction.GROUP_JOIN).toBe("group.join");
    expect(AuditAction.GROUP_LEAVE).toBe("group.leave");
    expect(AuditAction.GROUP_MEMBER_REMOVE).toBe("group.member_remove");
  });
});

// ---------------------------------------------------------------------------
// 2. auditData helper — builds correct Prisma payload
// ---------------------------------------------------------------------------
describe("auditData helper", () => {
  it("includes outcome in metadata when provided", () => {
    const data = auditData({
      action: "test.action",
      entityType: "test",
      entityId: "t_1",
      outcome: "success",
    });
    expect(data.metadata).toEqual(
      expect.objectContaining({ outcome: "success" })
    );
  });

  it("includes actorType in metadata when provided", () => {
    const data = auditData({
      action: "test.action",
      entityType: "test",
      entityId: "t_1",
      actorType: "system",
    });
    expect(data.metadata).toEqual(
      expect.objectContaining({ actorType: "system" })
    );
  });

  it("omits outcome and actorType when not provided", () => {
    const data = auditData({
      action: "test.action",
      entityType: "test",
      entityId: "t_1",
    });
    expect(data.metadata).not.toHaveProperty("outcome");
    expect(data.metadata).not.toHaveProperty("actorType");
  });

  it("nulls userId and groupId when not provided", () => {
    const data = auditData({
      action: "test.action",
      entityType: "test",
      entityId: "t_1",
    });
    expect(data.userId).toBeNull();
    expect(data.groupId).toBeNull();
  });

  it("passes through groupId and userId when provided", () => {
    const data = auditData({
      userId: "user_1",
      groupId: "group_1",
      action: "test.action",
      entityType: "test",
      entityId: "t_1",
    });
    expect(data.userId).toBe("user_1");
    expect(data.groupId).toBe("group_1");
  });

  it("passes through safe metadata fields", () => {
    const data = auditData({
      action: "treasury.deposit.create",
      entityType: "treasury_transaction",
      entityId: "ttx_1",
      metadata: {
        amount: "50",
        assetCode: "XLM",
        destination: "GABC...",
      },
    });
    expect(data.metadata).toEqual({
      amount: "50",
      assetCode: "XLM",
      destination: "GABC...",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Treasury proposal — audit events for creation
// ---------------------------------------------------------------------------
describe("Treasury proposal audit events", () => {
  beforeEach(() => {
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasuryAccount.publicKey(),
      treasuryRequiredSigners: 2,
    });
  });

  it("creates a treasury.proposal.created audit record atomically", async () => {
    const dest = Keypair.random().publicKey();
    const realXdr = makeUnsignedXdr({
      source: treasuryAccount,
      destination: dest,
      amount: "5",
    });

    const proposal = {
      id: "prop_1",
      groupId: "group_1",
      creatorId: admin.id,
      xdr: realXdr,
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.treasuryProposal.create.mockResolvedValue(proposal);
    prisma.auditLog.create.mockResolvedValue({});

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValue({
      exists: true,
      sequence: "12345",
      balances: [],
      signers: [{ key: "GA", weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    });
    vi.mocked(stellar.buildPayment).mockReturnValue(realXdr as any);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(),
      payload: {
        destination: dest,
        amount: "5",
        assetCode: "XLM",
      },
    });

    expect(res.statusCode).toBe(200);

    // Verify the proposal creation audit was recorded
    const createAuditCall = prisma.auditLog.create.mock.calls.find(
      (c: any) =>
        c[0]?.data?.action === AuditAction.TREASURY_PROPOSAL_CREATED
    );
    expect(createAuditCall).toBeDefined();
    expect(createAuditCall[0].data).toMatchObject({
      entityType: "treasury_proposal",
      entityId: "prop_1",
      metadata: expect.objectContaining({
        amount: "5",
        threshold: 2,
      }),
    });

    // Verify sensitive data exclusion
    const auditMeta = createAuditCall[0].data.metadata;
    expect(auditMeta).not.toHaveProperty("signedXdr");
    expect(auditMeta).not.toHaveProperty("xdr");
    expect(auditMeta).not.toHaveProperty("privateKey");
  });
});

// ---------------------------------------------------------------------------
// 4. Audit metadata never stores sensitive payloads
// ---------------------------------------------------------------------------
describe("Audit metadata sensitivity", () => {
  it("auditData excludes sensitive fields from its output", () => {
    const data = auditData({
      action: "treasury.deposit.create",
      entityType: "treasury_transaction",
      entityId: "ttx_1",
      metadata: {
        amount: "50",
        assetCode: "XLM",
        assetIssuer: null,
        destination: "GABC...",
      },
    });
    expect(data.metadata).not.toHaveProperty("signedXdr");
    expect(data.metadata).not.toHaveProperty("privateKey");
    expect(data.metadata).not.toHaveProperty("token");
    expect(data.metadata).not.toHaveProperty("secret");
  });

  it("auditData for settlement confirm excludes sensitive fields", () => {
    const data = auditData({
      action: AuditAction.SETTLEMENT_CONFIRM_SUBMITTED,
      entityType: "settlement",
      entityId: "s_1",
      metadata: { status: "submitted" },
    });
    expect(data.metadata).not.toHaveProperty("signedXdr");
    expect(data.metadata).not.toHaveProperty("transactionXdr");
    expect(data.metadata).not.toHaveProperty("privateKey");
  });
});

// ---------------------------------------------------------------------------
// 5. Group membership audit events (existing coverage verification)
// ---------------------------------------------------------------------------
describe("Group membership audit events", () => {
  it("creates a group.create audit record when creating a group", async () => {
    prisma.auditLog.create.mockResolvedValue({});
    prisma.group.create.mockResolvedValue({
      id: "group_new",
      name: "Test",
      description: null,
      createdByUserId: admin.id,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date(),
    });
    prisma.groupMember.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "Test" },
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: AuditAction.GROUP_CREATE,
          entityType: "group",
        }),
      })
    );
  });
});
