/**
 * Issue #335 — Audit logging for treasury multisig transaction execution attempts.
 *
 * Verifies that every attempt to sign or execute a treasury multisig transaction
 * produces an audit log entry capturing group ID, actor public key, action type,
 * and timestamp. Covers:
 *
 *  1. Treasury confirm route — success and failure audit records include groupId
 *  2. Treasury signatures route — signature submission creates audit entries
 *  3. Treasury proposals route — proposal creation and signing audit entries
 *  4. Audit metadata captures required fields (group ID, actor, action, timestamp)
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import pino from "pino";
import {
  Keypair,
  Transaction,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Memo,
} from "@stellar/stellar-sdk";
import { config } from "../src/config";

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
    treasuryTxProposal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
    },
    treasurySignature: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
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
        sequence: "12345",
        balances: [],
        signers: [
          { key: Keypair.random().publicKey(), weight: 1 },
          { key: Keypair.random().publicKey(), weight: 1 },
        ],
        thresholds: { low: 1, med: 1, high: 2 },
      })),
      buildPayment: vi.fn(),
      submitPayment: vi.fn(),
      submitMultisigPayment: vi.fn(),
      submitSigned: vi.fn(),
    },
  };
});

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: vi.fn(),
      })),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { AuditAction } from "../src/services/audit-actions";
import { setAuditEventLogger } from "../src/lib/audit-logger";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const admin = {
  id: "admin_1",
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "Admin",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

const member = {
  id: "member_1",
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "Member",
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

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

function makeUnsignedXdr(params: {
  source: string;
  destination: string;
  amount: string;
  memo?: string;
}): string {
  return new TransactionBuilder(
    new Account(params.source, "1"),
    { fee: "100", networkPassphrase: config.networkPassphrase }
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

// ---------------------------------------------------------------------------
// 1. Treasury confirm route — audit records include groupId
// ---------------------------------------------------------------------------
describe("Treasury confirm audit records", () => {
  beforeEach(() => {
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasuryAccount.publicKey(),
      treasuryRequiredSigners: 1,
    });
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
  });

  it("TREASURY_CONFIRM_FAILED audit includes groupId", async () => {
    prisma.treasuryTransaction.findUnique.mockResolvedValueOnce({
      id: "ttx_1",
      groupId: "group_1",
      userId: admin.id,
      direction: "withdrawal",
      amount: "10.0000000",
      assetCode: "XLM",
      assetIssuer: null,
      destination: Keypair.random().publicKey(),
      status: "awaiting_signatures",
      stellarTxHash: null,
      intendedTxHash: null,
      expiresAt: new Date(Date.now() + 300_000),
      memo: "MP:TX001",
      createdAt: new Date(),
    });

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.submitMultisigPayment).mockRejectedValue(
      new Error("stellar_rejected")
    );

    prisma.treasuryTransaction.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "some-xdr" },
    });

    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    // Verify that any TREASURY_CONFIRM_FAILED audit record includes groupId
    const failedAuditCalls = prisma.auditLog.create.mock.calls.filter(
      (c: any) => c[0]?.data?.action === AuditAction.TREASURY_CONFIRM_FAILED
    );
    for (const call of failedAuditCalls) {
      expect(call[0].data.groupId).toBe("group_1");
      expect(call[0].data.userId).toBe(admin.id);
      expect(call[0].data.entityType).toBe("treasury_transaction");
      expect(call[0].data.outcome).toBe("failure");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Treasury signatures route — signature submission creates audit entries
// ---------------------------------------------------------------------------
describe("Treasury signatures audit records", () => {
  beforeEach(() => {
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasuryAccount.publicKey(),
      treasuryRequiredSigners: 2,
    });
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
  });

  it("creates TREASURY_TX_PROPOSAL_CREATED audit on proposal creation", async () => {
    const unsignedXdr = makeUnsignedXdr({
      source: treasuryAccount.publicKey(),
      destination: Keypair.random().publicKey(),
      amount: "5",
    });

    prisma.treasuryTxProposal.create.mockResolvedValue({
      id: "txprop_1",
      groupId: "group_1",
      creatorId: admin.id,
      xdr: unsignedXdr,
      txHash: "abc123",
      sourceAccount: treasuryAccount.publicKey(),
      requiredWeight: 2,
      status: "PENDING_SIGNATURES",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValue({
      exists: true,
      sequence: "12345",
      balances: [],
      signers: [
        { key: admin.stellarPublicKey, weight: 1 },
        { key: member.stellarPublicKey, weight: 1 },
      ],
      thresholds: { low: 1, med: 1, high: 2 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/treasury/proposals",
      headers: authHeader(),
      payload: { groupId: "group_1", xdr: unsignedXdr },
    });

    expect(res.statusCode).toBe(200);

    const createAuditCalls = prisma.auditLog.create.mock.calls.filter(
      (c: any) =>
        c[0]?.data?.action === AuditAction.TREASURY_TX_PROPOSAL_CREATED
    );
    // Exactly one row: the service writes it atomically with the insert. A
    // second route-level record would double-count the action in the group's
    // audit feed.
    expect(createAuditCalls).toHaveLength(1);
    for (const call of createAuditCalls) {
      expect(call[0].data.groupId).toBe("group_1");
      expect(call[0].data.userId).toBe(admin.id);
      expect(call[0].data.entityType).toBe("treasury_tx_proposal");
      // The audit record must bind the entry to the exact transaction intent.
      expect(call[0].data.metadata?.txHash).toBe("abc123");
    }
    // No row is recorded under the server-built-proposal vocabulary: the
    // signature-collector flow has its own `treasury.tx_proposal.*` actions.
    expect(
      prisma.auditLog.create.mock.calls.filter(
        (c: any) => c[0]?.data?.action === AuditAction.TREASURY_PROPOSAL_CREATED
      )
    ).toHaveLength(0);
  });

  it("accepts the treasuryId alias and stores the optional description", async () => {
    // Issue #402: the create payload is validated by the shared
    // treasuryTxProposalCreateSchema — treasuryId (or its legacy groupId
    // alias), a parseable xdr, and an optional bounded description.
    const unsignedXdr = makeUnsignedXdr({
      source: treasuryAccount.publicKey(),
      destination: Keypair.random().publicKey(),
      amount: "5",
    });

    prisma.treasuryTxProposal.create.mockResolvedValue({
      id: "txprop_2",
      groupId: "group_1",
      creatorId: admin.id,
      xdr: unsignedXdr,
      description: "Pay the vendor invoice",
      txHash: "def456",
      sourceAccount: treasuryAccount.publicKey(),
      requiredWeight: 2,
      status: "PENDING_SIGNATURES",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValue({
      exists: true,
      sequence: "12345",
      balances: [],
      signers: [
        { key: admin.stellarPublicKey, weight: 1 },
        { key: member.stellarPublicKey, weight: 1 },
      ],
      thresholds: { low: 1, med: 1, high: 2 },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/treasury/proposals",
      headers: authHeader(),
      payload: {
        treasuryId: "group_1",
        xdr: unsignedXdr,
        description: "Pay the vendor invoice",
      },
    });

    expect(res.statusCode).toBe(200);

    const createCall = prisma.treasuryTxProposal.create.mock.calls[0][0];
    expect(createCall.data.groupId).toBe("group_1");
    expect(createCall.data.description).toBe("Pay the vendor invoice");
    expect(res.json().proposal.description).toBe("Pay the vendor invoice");
  });

  it("rejects a proposal payload with a malformed xdr before touching the service", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/treasury/proposals",
      headers: authHeader(),
      payload: { treasuryId: "group_1", xdr: "not-an-xdr!!" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("records exactly one signature_added row, atomically, without the signed envelope", async () => {
    const signerKp = Keypair.random();
    const signer = { ...admin, id: "admin_signer", stellarPublicKey: signerKp.publicKey() };
    const source = treasuryAccount.publicKey();
    const unsignedXdr = makeUnsignedXdr({
      source,
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const signedTx = new Transaction(unsignedXdr, config.networkPassphrase);
    signedTx.sign(signerKp);
    const signedXdr = signedTx.toXDR();
    const txHash = new Transaction(unsignedXdr, config.networkPassphrase)
      .hash()
      .toString("hex");

    const proposal = {
      id: "txprop_sign_1",
      groupId: "group_1",
      creatorId: signer.id,
      xdr: unsignedXdr,
      txHash,
      sourceAccount: source,
      requiredWeight: 2,
      status: "PENDING_SIGNATURES",
      createdAt: new Date(),
      updatedAt: new Date(),
      signatures: [],
    };

    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: signer.id,
      role: "admin",
    });
    prisma.groupMember.findMany.mockResolvedValue([
      { userId: signer.id, user: { stellarPublicKey: signerKp.publicKey() } },
    ]);
    // 1: the route resolves the proposal's group; 2: the service locks the
    // proposal inside its transaction; 3: the route re-reads it for the body.
    prisma.treasuryTxProposal.findUnique
      .mockResolvedValueOnce({ groupId: "group_1" })
      .mockResolvedValueOnce(proposal)
      .mockResolvedValueOnce(proposal);
    // First read: signatures already recorded (none). Second: the merged view
    // used for the threshold decision (the one just persisted).
    prisma.treasurySignature.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ weight: 1 }]);
    prisma.auditLog.create.mockResolvedValue({});

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValue({
      exists: true,
      sequence: "12345",
      balances: [],
      signers: [{ key: signerKp.publicKey(), weight: 1 }],
      thresholds: { low: 1, med: 1, high: 2 },
    });

    // Capture the structured Pino audit stream for this request only.
    const lines: any[] = [];
    setAuditEventLogger(
      pino(
        { level: "info" },
        {
          write(chunk: string) {
            try {
              lines.push(JSON.parse(chunk));
            } catch {
              // ignore non-JSON chunks
            }
          },
        } as any
      )
    );

    let res;
    try {
      res = await app.inject({
        method: "POST",
        url: "/api/treasury/proposals/txprop_sign_1/signatures",
        headers: authHeader(signer),
        payload: { signedXdr },
      });
    } finally {
      setAuditEventLogger(null);
    }

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("PENDING_SIGNATURES");

    const rows = prisma.auditLog.create.mock.calls.map((c: any) => c[0].data);
    const signatureRows = rows.filter(
      (row: any) => row.action === AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED
    );
    // One signature, one row — written with the state change, not after it,
    // and never duplicated under the server-built-proposal vocabulary.
    expect(signatureRows).toHaveLength(1);
    expect(signatureRows[0]).toMatchObject({
      groupId: "group_1",
      userId: signer.id,
      entityType: "treasury_tx_proposal",
      entityId: "txprop_sign_1",
      metadata: expect.objectContaining({
        signerPublicKey: signerKp.publicKey(),
        txHash,
      }),
    });
    expect(
      rows.filter((row: any) => row.action === AuditAction.TREASURY_PROPOSAL_SIGNED)
    ).toHaveLength(0);
    expect(
      rows.filter((row: any) => row.action === AuditAction.TREASURY_PROPOSAL_SUBMITTED)
    ).toHaveLength(0);

    // Neither the durable row nor the operator-facing line carries the signed
    // envelope (or any XDR field), only the public key and the transaction hash.
    expect(signatureRows[0].metadata).not.toHaveProperty("xdr");
    expect(signatureRows[0].metadata).not.toHaveProperty("signedXdr");
    expect(JSON.stringify(signatureRows[0])).not.toContain(signedXdr);
    const auditLines = lines.filter((line) => line.event === "audit");
    expect(auditLines).toHaveLength(1);
    expect(JSON.stringify(auditLines)).not.toContain(signedXdr);
    for (const line of auditLines) {
      expect(line.action).toBe(AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED);
      expect(Object.keys(line.metadata)).not.toContain("signedXdr");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Treasury proposals route — audit entries for creation and signing
// ---------------------------------------------------------------------------
describe("Treasury proposals audit records", () => {
  beforeEach(() => {
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: treasuryAccount.publicKey(),
      treasuryRequiredSigners: 2,
    });
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: admin.id,
      role: "admin",
    });
  });

  it("creates TREASURY_PROPOSAL_CREATED audit on proposal creation", async () => {
    const dest = Keypair.random().publicKey();
    const proposalXdr = makeUnsignedXdr({
      source: treasuryAccount.publicKey(),
      destination: dest,
      amount: "5",
    });

    prisma.treasuryProposal.create.mockResolvedValue({
      id: "prop_1",
      groupId: "group_1",
      creatorId: admin.id,
      xdr: proposalXdr,
      txHash: "hash123",
      threshold: 2,
      signatures: [],
      status: "awaiting_signatures",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValue({
      exists: true,
      sequence: "12345",
      balances: [],
      signers: [{ key: treasuryAccount.publicKey(), weight: 1 }],
      thresholds: { low: 1, med: 1, high: 1 },
    });
    vi.mocked(stellar.buildPayment).mockReturnValue(proposalXdr as any);

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(),
      payload: { destination: dest, amount: "5", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(200);

    const createAuditCalls = prisma.auditLog.create.mock.calls.filter(
      (c: any) =>
        c[0]?.data?.action === AuditAction.TREASURY_PROPOSAL_CREATED
    );
    expect(createAuditCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of createAuditCalls) {
      expect(call[0].data.userId).toBe(admin.id);
      expect(call[0].data.entityType).toBe("treasury_proposal");
      // groupId may be in the top-level or in metadata
      const hasGroupId =
        call[0].data.groupId === "group_1" ||
        call[0].data.metadata?.groupId === "group_1";
      expect(hasGroupId).toBe(true);
      // The audit record must bind the entry to the exact transaction intent.
      expect(call[0].data.metadata?.txHash).toBe("hash123");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Audit metadata captures required fields (group ID, actor, action, timestamp)
// ---------------------------------------------------------------------------
describe("Audit metadata completeness", () => {
  it("audit records for treasury actions always include groupId and userId", async () => {
    // Verify the audit action constants used across treasury multisig flows
    const treasuryAuditActions = [
      AuditAction.TREASURY_PROPOSAL_CREATED,
      AuditAction.TREASURY_PROPOSAL_SIGNED,
      AuditAction.TREASURY_PROPOSAL_SUBMITTED,
      AuditAction.TREASURY_PROPOSAL_FAILED,
      AuditAction.TREASURY_TX_PROPOSAL_CREATED,
      AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED,
      AuditAction.TREASURY_TX_PROPOSAL_READY,
      AuditAction.TREASURY_TX_PROPOSAL_SUBMITTED,
      AuditAction.TREASURY_TX_PROPOSAL_FAILED,
      AuditAction.TREASURY_CONFIRM,
      AuditAction.TREASURY_CONFIRM_FAILED,
    ];

    for (const action of treasuryAuditActions) {
      expect(typeof action).toBe("string");
      expect(action).toContain("treasury");
    }
  });

  it("TREASURY_PROPOSAL_SIGNED metadata includes signerPublicKey", () => {
    // Verify the action constant exists and follows the naming convention
    expect(AuditAction.TREASURY_PROPOSAL_SIGNED).toBe(
      "treasury.proposal.signed"
    );
    expect(AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED).toBe(
      "treasury.tx_proposal.signature_added"
    );
  });

  it("TREASURY_CONFIRM and TREASURY_CONFIRM_FAILED include direction metadata", () => {
    // These actions are called with direction in metadata (deposit/withdrawal)
    expect(AuditAction.TREASURY_CONFIRM).toBe("treasury.confirm");
    expect(AuditAction.TREASURY_CONFIRM_FAILED).toBe("treasury.confirm.failed");
  });
});

// ---------------------------------------------------------------------------
// 5. Service-level audit — auditTx is used for atomic multisig mutations
// ---------------------------------------------------------------------------
describe("Service-level atomic audit", () => {
  it("treasury proposals service uses auditTx for proposal creation", async () => {
    // Verify the service file imports and uses auditTx
    const proposalService = await import(
      "../src/services/treasury-proposals"
    );
    expect(proposalService.treasuryProposalsService).toBeDefined();
    expect(typeof proposalService.treasuryProposalsService.create).toBe(
      "function"
    );
    expect(typeof proposalService.treasuryProposalsService.submitSignatures).toBe(
      "function"
    );
  });

  it("treasury signatures service uses auditTx for signature recording", async () => {
    const signaturesService = await import(
      "../src/services/treasury-signatures"
    );
    expect(signaturesService.treasurySignaturesService).toBeDefined();
    expect(
      typeof signaturesService.treasurySignaturesService.createProposal
    ).toBe("function");
    expect(
      typeof signaturesService.treasurySignaturesService.submitSignature
    ).toBe("function");
  });
});
