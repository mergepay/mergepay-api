/**
 * Issue #924 — audit records for the treasury multisig proposal and signing
 * handlers.
 *
 * Every state-changing multisig transition must land one durable row in
 * `audit_logs` naming the actor, the action, the target proposal, the group
 * and the transaction it concerns — without ever carrying envelope bytes.
 * The helpers that write those rows already exist (`auditMultisigActionTx`,
 * src/services/audit.ts); what this suite pins is the *handler* behaviour the
 * issue asks for, end to end through `app.inject`, for both multisig flows:
 *
 *   1. Signature collector (caller-supplied envelope)
 *        POST /api/treasury/proposals                      → tx_proposal.created
 *        POST /api/treasury/proposals/:id/signatures       → signature_added,
 *                                                             ready, submitted
 *   2. Server-built payment proposal
 *        POST /groups/:groupId/treasury/proposals          → proposal.created
 *        POST /groups/:groupId/treasury/proposals/:id/sign → proposal.signed,
 *                                                             proposal.submitted
 *
 * Assertions per successful request:
 *   - exactly one row per transition (written inside the mutation's
 *     transaction, never duplicated at the route level),
 *   - actor id + actor public key + group id + proposal id + action,
 *   - the transaction identifier (`txHash`, plus `stellarTxHash` once
 *     broadcast) tying the row to the envelope every signer reviewed,
 *   - a timestamp on the mirrored structured audit line, with the durable
 *     row's `createdAt` left to the schema default,
 *   - no `xdr` / `signedXdr` / envelope bytes anywhere in the record.
 *
 * Prisma and Horizon are mocked (no DB or network in `npm test`); the audit
 * rows are read back from the mocked `auditLog.create` calls.
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
    findUniqueOrThrow: vi.fn(),
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
    treasuryProposal: model(),
    treasuryTxProposal: model(),
    treasurySignature: model(),
    treasuryApproval: model(),
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
      loadAccount: vi.fn(),
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
import { stellar } from "../src/services/stellar";
import { AuditAction } from "../src/services/audit-actions";
import { setAuditEventLogger } from "../src/lib/audit-logger";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const treasuryAccount = Keypair.random();

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

/** An externally built, unsigned, treasury-sourced payment envelope. */
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

function txHashOf(unsignedXdr: string): string {
  return new Transaction(unsignedXdr, config.networkPassphrase)
    .hash()
    .toString("hex");
}

/** Every audit row written to the mocked `audit_logs` table. */
function auditRows(): any[] {
  return prisma.auditLog.create.mock.calls.map((c: any) => c[0].data);
}

function rowsFor(action: string): any[] {
  return auditRows().filter((row) => row.action === action);
}

/** Capture the mirrored structured audit lines while `fn` runs. */
async function captureAuditLines<T>(fn: () => Promise<T>): Promise<{
  result: T;
  lines: any[];
}> {
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
  try {
    const result = await fn();
    return { result, lines: lines.filter((l) => l.event === "audit") };
  } finally {
    setAuditEventLogger(null);
  }
}

function seedTreasuryGroup(overrides: Record<string, unknown> = {}) {
  prisma.group.findUnique.mockResolvedValue({
    id: "group_1",
    treasuryEnabled: true,
    treasuryAccountPublicKey: treasuryAccount.publicKey(),
    treasuryRequiredSigners: 1,
    ...overrides,
  });
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: "group_1",
    userId: admin.id,
    role: "admin",
  });
}

function seedFundedTreasury(
  signers: Array<{ key: string; weight: number }>,
  thresholds = { low: 1, med: 1, high: 1 }
) {
  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [],
    signers,
    thresholds,
  } as any);
}

beforeEach(async () => {
  vi.clearAllMocks();
  seedTreasuryGroup();
  if (!app) app = await buildApp();
});

// ---------------------------------------------------------------------------
// 1. Signature-collector flow — proposal creation
// ---------------------------------------------------------------------------
describe("POST /api/treasury/proposals — proposal audit record (#924)", () => {
  it("writes exactly one tx_proposal.created row with actor, group, proposal and tx hash", async () => {
    const unsignedXdr = makeUnsignedXdr({
      source: treasuryAccount.publicKey(),
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const txHash = txHashOf(unsignedXdr);

    // The created row is echoed back into the audit row written in the same
    // transaction, so both come from one source of truth.
    prisma.treasuryTxProposal.create.mockImplementation(async ({ data }: any) => ({
      id: "ttp_1",
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
    seedFundedTreasury(
      [{ key: admin.stellarPublicKey, weight: 1 }],
      { low: 1, med: 1, high: 1 }
    );

    const { result, lines } = await captureAuditLines(() =>
      app.inject({
        method: "POST",
        url: "/api/treasury/proposals",
        headers: authHeader(),
        payload: { treasuryId: "group_1", xdr: unsignedXdr },
      })
    );

    expect(result.statusCode).toBe(200);

    const created = rowsFor(AuditAction.TREASURY_TX_PROPOSAL_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      groupId: "group_1",
      userId: admin.id,
      entityType: "treasury_tx_proposal",
      entityId: "ttp_1",
    });
    // Actor public key (public material only) and the transaction identity.
    expect(created[0].metadata.actorPublicKey).toBe(admin.stellarPublicKey);
    expect(created[0].metadata.txHash).toBe(txHash);
    expect(created[0].metadata.outcome).toBe("success");
    // The row's timestamp comes from the schema default, never from a caller.
    expect(created[0]).not.toHaveProperty("createdAt");
    // Mirrored structured line carries the timestamp operators filter on.
    expect(lines).toHaveLength(1);
    expect(lines[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(lines[0].actor).toEqual({ type: "user", id: admin.id });

    // No envelope bytes — in the row, its metadata, or the log line.
    expect(created[0].metadata).not.toHaveProperty("xdr");
    expect(JSON.stringify(created[0])).not.toContain(unsignedXdr);
    expect(JSON.stringify(lines)).not.toContain(unsignedXdr);
  });
});

// ---------------------------------------------------------------------------
// 2. Signature-collector flow — signing, threshold, broadcast
// ---------------------------------------------------------------------------
describe("POST /api/treasury/proposals/:id/signatures — signing audit records (#924)", () => {
  it("records signature_added, ready and submitted rows with the actor and tx hash", async () => {
    const signerKp = Keypair.random();
    const signer = { ...admin, id: "admin_signer", stellarPublicKey: signerKp.publicKey() };
    const source = treasuryAccount.publicKey();
    const unsignedXdr = makeUnsignedXdr({
      source,
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const txHash = txHashOf(unsignedXdr);
    const signed = new Transaction(unsignedXdr, config.networkPassphrase);
    signed.sign(signerKp);
    const signedXdr = signed.toXDR();

    const proposal = {
      id: "ttp_sign_1",
      groupId: "group_1",
      creatorId: signer.id,
      xdr: unsignedXdr,
      description: null,
      txHash,
      sourceAccount: source,
      requiredWeight: 1,
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
    // Route: resolve the proposal's group. Service: lock the row. Route: read
    // it back for the response body.
    const txProposalReads = [{ groupId: "group_1" }, proposal, proposal];
    prisma.treasuryTxProposal.findUnique.mockImplementation(async () =>
      txProposalReads.shift() ?? proposal
    );
    prisma.groupMember.findMany.mockResolvedValue([
      { userId: signer.id, user: { stellarPublicKey: signerKp.publicKey() } },
    ]);
    // Existing signatures, then the merged view the threshold is decided on.
    const signatureReads: any[] = [[], [{ weight: 1 }]];
    prisma.treasurySignature.findMany.mockImplementation(async () =>
      signatureReads.shift() ?? []
    );
    prisma.treasurySignature.create.mockResolvedValue({});
    prisma.treasuryTxProposal.update.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
    seedFundedTreasury([{ key: signerKp.publicKey(), weight: 1 }], {
      low: 1,
      med: 1,
      high: 1,
    });
    vi.mocked(stellar.submitSigned).mockResolvedValue("onchainhashcollector");

    const res = await app.inject({
      method: "POST",
      url: "/api/treasury/proposals/ttp_sign_1/signatures",
      headers: authHeader(signer),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("SUBMITTED");

    const signatureRows = rowsFor(AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED);
    expect(signatureRows).toHaveLength(1);
    expect(signatureRows[0]).toMatchObject({
      groupId: "group_1",
      userId: signer.id,
      entityType: "treasury_tx_proposal",
      entityId: "ttp_sign_1",
    });
    expect(signatureRows[0].metadata).toMatchObject({
      signerPublicKey: signerKp.publicKey(),
      txHash,
      outcome: "success",
    });

    const readyRows = rowsFor(AuditAction.TREASURY_TX_PROPOSAL_READY);
    expect(readyRows).toHaveLength(1);
    expect(readyRows[0].metadata).toMatchObject({
      totalWeight: 1,
      requiredWeight: 1,
      txHash,
      actorPublicKey: signerKp.publicKey(),
    });

    const submittedRows = rowsFor(AuditAction.TREASURY_TX_PROPOSAL_SUBMITTED);
    expect(submittedRows).toHaveLength(1);
    expect(submittedRows[0]).toMatchObject({
      groupId: "group_1",
      userId: signer.id,
      entityId: "ttp_sign_1",
    });
    // Which envelope was signed, and which transaction it became on-chain.
    expect(submittedRows[0].metadata).toMatchObject({
      txHash,
      stellarTxHash: "onchainhashcollector",
      actorPublicKey: signerKp.publicKey(),
    });

    // One row per transition — nothing is written twice at the route level.
    expect(rowsFor(AuditAction.TREASURY_PROPOSAL_SIGNED)).toHaveLength(0);
    expect(rowsFor(AuditAction.TREASURY_PROPOSAL_SUBMITTED)).toHaveLength(0);

    // Envelope bytes never reach the trail.
    expect(JSON.stringify(auditRows())).not.toContain(signedXdr);
    expect(JSON.stringify(auditRows())).not.toContain(unsignedXdr);
    for (const row of auditRows()) {
      expect(row.metadata).not.toHaveProperty("signedXdr");
      expect(row.metadata).not.toHaveProperty("xdr");
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Server-built proposal flow — creation
// ---------------------------------------------------------------------------
describe("POST /groups/:groupId/treasury/proposals — proposal audit record (#924)", () => {
  it("writes a treasury.proposal.created row with the creator, group and tx hash", async () => {
    const destination = Keypair.random().publicKey();
    const builtXdr = makeUnsignedXdr({
      source: treasuryAccount.publicKey(),
      destination,
      amount: "5",
    });
    const txHash = txHashOf(builtXdr);

    vi.mocked(stellar.buildPayment).mockReturnValue(builtXdr as any);
    seedFundedTreasury([{ key: treasuryAccount.publicKey(), weight: 1 }]);
    prisma.treasuryProposal.create.mockImplementation(async ({ data }: any) => ({
      id: "prop_1",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
    prisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals",
      headers: authHeader(),
      payload: { destination, amount: "5", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(200);

    const created = rowsFor(AuditAction.TREASURY_PROPOSAL_CREATED);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      groupId: "group_1",
      userId: admin.id,
      entityType: "treasury_proposal",
      entityId: "prop_1",
      metadata: {
        actorPublicKey: admin.stellarPublicKey,
        txHash,
        destination,
        amount: "5",
        outcome: "success",
      },
    });
    expect(created[0]).not.toHaveProperty("createdAt");
    expect(JSON.stringify(created[0])).not.toContain(builtXdr);
  });
});

// ---------------------------------------------------------------------------
// 4. Server-built proposal flow — signing and broadcast
// ---------------------------------------------------------------------------
describe("POST /groups/:groupId/treasury/proposals/:id/sign — signing audit records (#924)", () => {
  it("records treasury.proposal.signed and treasury.proposal.submitted with actor and tx hash", async () => {
    const signerKp = Keypair.random();
    const signer = { ...admin, id: "admin_signer", stellarPublicKey: signerKp.publicKey() };
    const unsignedXdr = makeUnsignedXdr({
      source: treasuryAccount.publicKey(),
      destination: Keypair.random().publicKey(),
      amount: "5",
    });
    const txHash = txHashOf(unsignedXdr);
    const signed = new Transaction(unsignedXdr, config.networkPassphrase);
    signed.sign(signerKp);
    const signedXdr = signed.toXDR();

    const proposal = {
      id: "prop_sign_1",
      groupId: "group_1",
      creatorId: signer.id,
      xdr: unsignedXdr,
      txHash,
      threshold: 1,
      signatures: [],
      status: "awaiting_signatures",
      stellarTxHash: null,
      failureReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: signer.id,
      role: "admin",
    });
    prisma.groupMember.findMany.mockResolvedValue([
      { userId: signer.id, user: { stellarPublicKey: signerKp.publicKey() } },
    ]);
    prisma.treasuryProposal.findUnique.mockResolvedValue(proposal);
    prisma.treasuryProposal.update.mockResolvedValue({});
    prisma.treasuryApproval.findMany.mockResolvedValue([]);
    prisma.treasuryApproval.create.mockResolvedValue({});
    prisma.auditLog.create.mockResolvedValue({});
    vi.mocked(stellar.submitSigned).mockResolvedValue("onchainhashserverbuilt");

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/proposals/prop_sign_1/sign",
      headers: authHeader(signer),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);

    const signedRows = rowsFor(AuditAction.TREASURY_PROPOSAL_SIGNED);
    expect(signedRows).toHaveLength(1);
    expect(signedRows[0]).toMatchObject({
      groupId: "group_1",
      userId: signer.id,
      entityType: "treasury_proposal",
      entityId: "prop_sign_1",
      metadata: {
        signerPublicKey: signerKp.publicKey(),
        txHash,
        outcome: "success",
      },
    });

    const submittedRows = rowsFor(AuditAction.TREASURY_PROPOSAL_SUBMITTED);
    expect(submittedRows).toHaveLength(1);
    expect(submittedRows[0]).toMatchObject({
      groupId: "group_1",
      userId: signer.id,
      entityId: "prop_sign_1",
      metadata: {
        txHash,
        stellarTxHash: "onchainhashserverbuilt",
        actorPublicKey: signerKp.publicKey(),
      },
    });

    // A signature alone must not be recorded as a submission.
    expect(rowsFor(AuditAction.TREASURY_TX_PROPOSAL_SIGNATURE_ADDED)).toHaveLength(0);
    expect(rowsFor(AuditAction.TREASURY_TX_PROPOSAL_SUBMITTED)).toHaveLength(0);

    expect(JSON.stringify(auditRows())).not.toContain(signedXdr);
    expect(JSON.stringify(auditRows())).not.toContain(unsignedXdr);
  });
});

// ---------------------------------------------------------------------------
// 5. Rejected attempts change nothing — and say so
// ---------------------------------------------------------------------------
describe("rejected multisig attempts write no audit row (#924)", () => {
  it("writes no row when a non-admin proposes a treasury transaction", async () => {
    prisma.groupMember.findUnique.mockResolvedValue({
      groupId: "group_1",
      userId: admin.id,
      role: "member",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/treasury/proposals",
      headers: authHeader(),
      payload: {
        treasuryId: "group_1",
        xdr: makeUnsignedXdr({
          source: treasuryAccount.publicKey(),
          destination: Keypair.random().publicKey(),
          amount: "5",
        }),
      },
    });

    expect(res.statusCode).toBe(403);
    expect(auditRows()).toHaveLength(0);
    expect(prisma.treasuryTxProposal.create).not.toHaveBeenCalled();
  });

  it("writes no row for a malformed proposal payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/treasury/proposals",
      headers: authHeader(),
      payload: { treasuryId: "group_1", xdr: "not-an-xdr!!" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("VALIDATION_ERROR");
    expect(auditRows()).toHaveLength(0);
  });
});
