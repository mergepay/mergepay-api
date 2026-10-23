/**
 * Issue #917 — audit rows for group administration and treasury multisig
 * operations, verified against a real Postgres.
 *
 * The existing audit suites replace `src/db` with `vi.mock` objects, so their
 * "records" are values the test handed back to itself. This file uses the real
 * Prisma client, the real Fastify instance and the real HTTP path
 * (`app.inject`), so every assertion reads back what Postgres actually stored.
 * Only Horizon is substituted (`src/services/stellar`), because CONTRIBUTING
 * requires the suite to run without network access.
 *
 * Covered end to end:
 *   - group creation, member addition, role change and member removal
 *   - treasury multisig proposal creation, signing and execution
 *   - refusal paths write no audit row and leave state unchanged
 *   - a failing audit insert rolls the mutation back (atomicity)
 *   - audit metadata carries identifiers, never key material or envelope bytes
 *
 * The global harness in tests/integration/db empties every table once per run,
 * so each assertion is scoped to a group created by this suite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";
import type { FastifyInstance } from "fastify";
import type { Prisma } from "@prisma/client";

const h = vi.hoisted(() => ({
  submitCalls: [] as string[],
  submitResult: "917-audit-on-chain-hash",
}));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      // The treasury account is funded and has a trivial single-signer
      // configuration; #917 is about the audit trail, not the policy engine.
      loadAccount: vi.fn(async () => ({
        exists: true,
        sequence: "1",
        balances: [{ assetCode: "XLM", assetIssuer: null, balance: "10000.0000000" }],
        signers: [],
        thresholds: { low: 1, med: 1, high: 1 },
      })),
      submitSigned: vi.fn(async (xdr: string) => {
        h.submitCalls.push(xdr);
        return h.submitResult;
      }),
    },
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { prisma } from "../../src/db";
import { signToken } from "../../src/plugins/auth";
import { AuditAction } from "../../src/services/audit-actions";

interface Actor {
  id: string;
  publicKey: string;
  token: string;
  keypair: Keypair;
}

let app: FastifyInstance;
let owner: Actor;
/** Joins the group and is promoted to admin in the role-change test. */
let member: Actor;
/** Joins and is later removed. */
let removedMember: Actor;
/** Stays a plain member, so authorization refusals are genuinely unauthorized. */
let plainMember: Actor;
/** Joins a second group only for the atomicity test. */
let atomicMember: Actor;

let groupId: string;
let treasuryPublicKey: string;
let proposalId: string;
let proposalXdr: string;
let signedXdr: string;

/**
 * A flag the Prisma middleware below reads. Set only while the atomicity test
 * makes one request; a plain `null` leaves every other audit write untouched.
 */
let failingAuditAction: string | null = null;

let requestNumber = 0;

/** A distinct source address per request keeps rate-limit buckets independent. */
function remoteAddress(): string {
  requestNumber += 1;
  return `10.67.${Math.floor(requestNumber / 250) % 250}.${(requestNumber % 250) + 1}`;
}

async function createActor(displayName: string): Promise<Actor> {
  const keypair = Keypair.random();
  const user = await prisma.user.create({
    data: { stellarPublicKey: keypair.publicKey(), displayName },
    select: { id: true, stellarPublicKey: true },
  });
  return {
    id: user.id,
    publicKey: user.stellarPublicKey,
    keypair,
    token: signToken({ id: user.id, stellarPublicKey: keypair.publicKey() }),
  };
}

async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  actor: Actor | null,
  payload?: Record<string, unknown>
) {
  return app.inject({
    method,
    url,
    remoteAddress: remoteAddress(),
    headers: actor ? { authorization: `Bearer ${actor.token}` } : {},
    payload,
  });
}

function findAudit(where: Prisma.AuditLogWhereInput) {
  return prisma.auditLog.findFirst({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

function metadataOf(row: { metadata: Prisma.JsonValue }): Record<string, unknown> {
  return (row.metadata ?? {}) as Record<string, unknown>;
}

/** A row written by this request: not from an earlier test, not predated. */
function expectRecent(row: { createdAt: Date }, startedAt: Date): void {
  expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime() - 1_000);
  expect(Date.now() - row.createdAt.getTime()).toBeLessThan(30_000);
}

async function join(actor: Actor, code: string) {
  const res = await call("POST", "/groups/join", actor, { code });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  // A failing audit write must fail the whole transaction, not be swallowed.
  // `auditTx` deliberately propagates errors; this middleware forces one
  // `audit_logs` insert to fail so the rollback can be observed in Postgres.
  prisma.$use(async (params, next) => {
    if (failingAuditAction && params.model === "AuditLog" && params.action === "create") {
      const data = params.args?.data as { action?: unknown } | undefined;
      if (data?.action === failingAuditAction) {
        throw new Error("simulated audit write failure (#917)");
      }
    }
    return next(params);
  });

  // This suite is about the audit trail, not the limiter; CONTRIBUTING permits
  // booting without one when throttling is not the subject.
  app = await buildApp({ rateLimit: "off" });
  [owner, member, removedMember, plainMember, atomicMember] = await Promise.all([
    createActor("917 Owner"),
    createActor("917 Member"),
    createActor("917 Removed Member"),
    createActor("917 Plain Member"),
    createActor("917 Atomic Member"),
  ]);
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(() => {
  failingAuditAction = null;
  h.submitCalls = [];
});

describe("group administration audit rows (#917)", () => {
  it("records group creation with the actor, action, group id and a recent timestamp", async () => {
    const startedAt = new Date();
    const res = await call("POST", "/groups", owner, {
      name: "917 Audit Group",
      description: "Audit-trail integration suite",
    });
    expect(res.statusCode).toBe(200);
    groupId = res.json().group.id as string;

    const row = await findAudit({ groupId, action: AuditAction.GROUP_CREATE });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      userId: owner.id,
      groupId,
      action: AuditAction.GROUP_CREATE,
      entityType: "group",
      entityId: groupId,
    });
    expect(metadataOf(row!)).toMatchObject({
      name: "917 Audit Group",
      outcome: "success",
      actorType: "user",
    });
    expectRecent(row!, startedAt);
  });

  it("records each member addition as a group.join row", async () => {
    const invite = await call("POST", `/groups/${groupId}/invite`, owner, { maxUses: 10 });
    expect(invite.statusCode).toBe(200);
    const code = invite.json().invite.code as string;

    const startedAt = new Date();
    await Promise.all([
      join(member, code),
      join(removedMember, code),
      join(plainMember, code),
    ]);

    const rows = await prisma.auditLog.findMany({
      where: { groupId, action: AuditAction.GROUP_JOIN },
      orderBy: { createdAt: "asc" },
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [member.id, removedMember.id, plainMember.id].sort()
    );
    for (const row of rows) {
      expect(row).toMatchObject({
        groupId,
        entityType: "group",
        entityId: groupId,
      });
      expect(metadataOf(row)).toMatchObject({
        inviteId: invite.json().invite.id,
        outcome: "success",
      });
      expectRecent(row, startedAt);
    }
  });

  it("records a role change with the actor and the old/new roles", async () => {
    const startedAt = new Date();
    const res = await call("POST", `/groups/${groupId}/members/role`, owner, {
      userId: member.id,
      role: "admin",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().member).toMatchObject({ userId: member.id, role: "admin" });

    const row = await findAudit({
      groupId,
      action: AuditAction.GROUP_MEMBER_ROLE_CHANGE,
      entityId: member.id,
    });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      userId: owner.id,
      groupId,
      action: AuditAction.GROUP_MEMBER_ROLE_CHANGE,
      entityType: "group_member",
      entityId: member.id,
    });
    expect(metadataOf(row!)).toMatchObject({
      targetUserId: member.id,
      previousRole: "member",
      newRole: "admin",
      outcome: "success",
    });
    expectRecent(row!, startedAt);
  });

  it("writes no audit row when a non-admin tries to change a role", async () => {
    const before = await prisma.auditLog.count({ where: { groupId } });

    const res = await call("POST", `/groups/${groupId}/members/role`, plainMember, {
      userId: removedMember.id,
      role: "admin",
    });
    expect(res.statusCode).toBe(403);

    // Neither the mutation nor an audit row for it may exist afterwards.
    const target = await prisma.groupMember.findUniqueOrThrow({
      where: { groupId_userId: { groupId, userId: removedMember.id } },
    });
    expect(target.role).toBe("member");
    expect(await prisma.auditLog.count({ where: { groupId } })).toBe(before);
  });

  it("records member removal with the acting admin and the removed member id", async () => {
    const startedAt = new Date();
    const res = await call("DELETE", `/groups/${groupId}/members/${removedMember.id}`, owner);
    expect(res.statusCode).toBe(200);

    expect(
      await prisma.groupMember.findUnique({
        where: { groupId_userId: { groupId, userId: removedMember.id } },
      })
    ).toBeNull();

    const row = await findAudit({
      groupId,
      action: AuditAction.GROUP_MEMBER_REMOVE,
      entityId: removedMember.id,
    });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      userId: owner.id,
      groupId,
      action: AuditAction.GROUP_MEMBER_REMOVE,
      entityType: "group_member",
      entityId: removedMember.id,
    });
    expect(metadataOf(row!)).toMatchObject({
      targetUserId: removedMember.id,
      removedRole: "member",
      outcome: "success",
    });
    expectRecent(row!, startedAt);
  });
});

describe("treasury multisig audit rows (#917)", () => {
  it("records proposal creation with the creator, treasury and proposal ids", async () => {
    treasuryPublicKey = Keypair.random().publicKey();
    const enabled = await call("POST", `/groups/${groupId}/treasury/enable`, owner, {
      publicKey: treasuryPublicKey,
      requiredSigners: 1,
    });
    expect(enabled.statusCode).toBe(200);

    const startedAt = new Date();
    const destination = Keypair.random().publicKey();
    const res = await call("POST", `/groups/${groupId}/treasury/proposals`, owner, {
      destination,
      amount: "5",
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(200);

    proposalId = res.json().proposal.id as string;
    proposalXdr = res.json().xdr as string;
    const stored = await prisma.treasuryProposal.findUniqueOrThrow({
      where: { id: proposalId },
    });

    const row = await findAudit({
      groupId,
      action: AuditAction.TREASURY_PROPOSAL_CREATED,
      entityId: proposalId,
    });
    expect(row).not.toBeNull();
    expect(row).toMatchObject({
      userId: owner.id,
      groupId,
      action: AuditAction.TREASURY_PROPOSAL_CREATED,
      entityType: "treasury_proposal",
      entityId: proposalId,
    });
    const metadata = metadataOf(row!);
    expect(metadata).toMatchObject({
      sourceAccount: treasuryPublicKey,
      destination,
      amount: "5",
      assetCode: "XLM",
      threshold: 1,
      outcome: "success",
    });
    expect(metadata.txHash).toBe(stored.txHash);
    expectRecent(row!, startedAt);
  });

  it("writes no audit row when a non-admin proposes a treasury payment", async () => {
    const before = await prisma.auditLog.count({ where: { groupId } });

    const res = await call("POST", `/groups/${groupId}/treasury/proposals`, plainMember, {
      destination: Keypair.random().publicKey(),
      amount: "5",
      assetCode: "XLM",
    });
    expect(res.statusCode).toBe(403);

    expect(await prisma.treasuryProposal.count({ where: { groupId } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { groupId } })).toBe(before);
  });

  it("records signing and execution with the acting user and the transaction hash", async () => {
    const tx = new Transaction(proposalXdr, config.networkPassphrase);
    tx.sign(member.keypair);
    signedXdr = tx.toXDR();

    const startedAt = new Date();
    const res = await call(
      "POST",
      `/groups/${groupId}/treasury/proposals/${proposalId}/sign`,
      member,
      { signedXdr }
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("confirmed");
    expect(res.json().stellarTxHash).toBe(h.submitResult);
    expect(h.submitCalls).toHaveLength(1);

    const signedRow = await findAudit({
      groupId,
      action: AuditAction.TREASURY_PROPOSAL_SIGNED,
      entityId: proposalId,
    });
    expect(signedRow).not.toBeNull();
    expect(signedRow).toMatchObject({
      userId: member.id,
      groupId,
      entityType: "treasury_proposal",
      entityId: proposalId,
    });
    expect(metadataOf(signedRow!)).toMatchObject({
      signerPublicKey: member.publicKey,
      signatureCount: 1,
      threshold: 1,
      outcome: "success",
    });
    expectRecent(signedRow!, startedAt);

    const submittedRow = await findAudit({
      groupId,
      action: AuditAction.TREASURY_PROPOSAL_SUBMITTED,
      entityId: proposalId,
    });
    expect(submittedRow).not.toBeNull();
    // Execution is attributed to the authenticated submitter, not left null.
    expect(submittedRow).toMatchObject({
      userId: member.id,
      groupId,
      entityType: "treasury_proposal",
      entityId: proposalId,
    });
    expect(metadataOf(submittedRow!)).toMatchObject({
      stellarTxHash: h.submitResult,
      signatureCount: 1,
      threshold: 1,
      outcome: "success",
    });
    expectRecent(submittedRow!, startedAt);
  });

  it("keeps audit metadata free of keys and envelope bytes", async () => {
    const row = await findAudit({
      action: AuditAction.TREASURY_PROPOSAL_CREATED,
      entityId: proposalId,
    });
    expect(row).not.toBeNull();
    const metadata = metadataOf(row!);

    expect(Object.keys(metadata)).not.toContain("xdr");
    expect(Object.keys(metadata)).not.toContain("signedXdr");
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain(proposalXdr);
    expect(serialized).not.toContain(signedXdr);
    expect(serialized).not.toContain(owner.keypair.secret());
    expect(serialized).not.toContain(member.keypair.secret());
    expect(serialized).not.toMatch(/\bS[A-Z2-7]{55}\b/);

    // Signing metadata records the signer's public key and the public
    // transaction hash, which is safe to keep; the signature itself is not.
    const signedRow = await findAudit({
      action: AuditAction.TREASURY_PROPOSAL_SIGNED,
      entityId: proposalId,
    });
    expect(JSON.stringify(metadataOf(signedRow!))).not.toContain(signedXdr);
  });
});

describe("audit write atomicity (#917)", () => {
  it("rolls the mutation back when the audit insert fails", async () => {
    const groupRes = await call("POST", "/groups", owner, { name: "917 Atomic Group" });
    expect(groupRes.statusCode).toBe(200);
    const atomicGroupId = groupRes.json().group.id as string;

    const invite = await call("POST", `/groups/${atomicGroupId}/invite`, owner, {
      maxUses: 2,
    });
    expect(invite.statusCode).toBe(200);
    await join(atomicMember, invite.json().invite.code as string);

    const before = await prisma.auditLog.count({
      where: { groupId: atomicGroupId, action: AuditAction.GROUP_MEMBER_ROLE_CHANGE },
    });

    failingAuditAction = AuditAction.GROUP_MEMBER_ROLE_CHANGE;
    try {
      const res = await call("POST", `/groups/${atomicGroupId}/members/role`, owner, {
        userId: atomicMember.id,
        role: "admin",
      });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("INTERNAL_ERROR");
    } finally {
      failingAuditAction = null;
    }

    // The role update ran before the audit insert in the same transaction, so
    // Postgres rolling back the failed insert must also undo the promotion.
    const membership = await prisma.groupMember.findUniqueOrThrow({
      where: { groupId_userId: { groupId: atomicGroupId, userId: atomicMember.id } },
    });
    expect(membership.role).toBe("member");
    expect(
      await prisma.auditLog.count({
        where: { groupId: atomicGroupId, action: AuditAction.GROUP_MEMBER_ROLE_CHANGE },
      })
    ).toBe(before);
  });
});
