import { afterEach, describe, expect, it } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { prisma } from "../../src/db";
import { expireStaleProposals } from "../../src/worker/cleanupProposals";
import { AuditAction } from "../../src/services/audit-actions";

const createdGroupIds: string[] = [];
const createdAuditIds: string[] = [];

afterEach(async () => {
  if (createdGroupIds.length) {
    await prisma.group.deleteMany({ where: { id: { in: createdGroupIds.splice(0) } } });
  }
  if (createdAuditIds.length) {
    await prisma.auditLog.deleteMany({ where: { id: { in: createdAuditIds.splice(0) } } });
  }
});

async function seedProposal(status: string, expiresAt: Date, createdAt: Date) {
  const user = await prisma.user.create({
    data: {
      stellarPublicKey: Keypair.random().publicKey(),
      displayName: `proposal-expiry-${Math.random().toString(36).slice(2)}`,
    },
  });
  const group = await prisma.group.create({
    data: {
      name: `proposal-expiry-${user.id}`,
      createdByUserId: user.id,
      members: { create: { userId: user.id, role: "admin" } },
    },
  });
  createdGroupIds.push(group.id);
  const proposal = await prisma.treasuryProposal.create({
    data: {
      groupId: group.id,
      creatorId: user.id,
      xdr: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      txHash: "expiry-test-hash",
      threshold: 2,
      status,
      expiresAt,
      createdAt,
    },
  });
  return proposal;
}

describe("treasury proposal expiry sweep", () => {
  it("expires a backdated proposal once and writes one audit row", async () => {
    const now = new Date();
    const expiresAt = new Date(now.getTime() - 60_000);
    const proposal = await seedProposal(
      "awaiting_signatures",
      expiresAt,
      new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
    );

    const first = await expireStaleProposals({ now, batchSize: 100 });
    const afterFirst = await prisma.treasuryProposal.findUnique({ where: { id: proposal.id } });
    const audits = await prisma.auditLog.findMany({
      where: {
        entityType: "treasury_proposal",
        entityId: proposal.id,
        action: AuditAction.TREASURY_PROPOSAL_EXPIRED,
      },
    });
    createdAuditIds.push(...audits.map((a) => a.id));

    expect(first.expired).toBeGreaterThanOrEqual(1);
    expect(afterFirst?.status).toBe("expired");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.userId).toBe(proposal.creatorId);

    const second = await expireStaleProposals({ now, batchSize: 100 });
    const auditsAfterSecond = await prisma.auditLog.count({
      where: {
        entityType: "treasury_proposal",
        entityId: proposal.id,
        action: AuditAction.TREASURY_PROPOSAL_EXPIRED,
      },
    });

    expect(second.expired).toBe(0);
    expect(auditsAfterSecond).toBe(1);
  });

  it("leaves a submitted proposal with a past expiry untouched", async () => {
    const now = new Date();
    const proposal = await seedProposal(
      "submitted",
      new Date(now.getTime() - 60_000),
      new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000)
    );

    await expireStaleProposals({ now, batchSize: 100 });

    const after = await prisma.treasuryProposal.findUnique({ where: { id: proposal.id } });
    expect(after?.status).toBe("submitted");
  });
});
