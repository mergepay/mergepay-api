import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    treasuryProposal: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn(async () => ({ id: "audit_1" })) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import {
  EXPIRED_STATUS,
  expireStaleProposals,
  proposalExpiryCutoff,
} from "../../src/worker/cleanupProposals";
import { config } from "../../src/config";

const prisma = h.prisma;

const NOW = new Date("2026-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const proposal = (over: Record<string, any> = {}) => ({
  id: "proposal_1",
  groupId: "group_1",
  creatorId: "user_1",
  createdAt: new Date(NOW.getTime() - 30 * DAY_MS),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.treasuryProposal.findMany.mockResolvedValue([]);
  prisma.treasuryProposal.updateMany.mockResolvedValue({ count: 1 });
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("proposalExpiryCutoff", () => {
  it("derives the cutoff from the configured age", () => {
    expect(proposalExpiryCutoff(NOW, 7)).toEqual(
      new Date(NOW.getTime() - 7 * DAY_MS)
    );
  });

  it("defaults to the configured threshold", () => {
    expect(proposalExpiryCutoff(NOW)).toEqual(
      new Date(NOW.getTime() - config.TREASURY_PROPOSAL_EXPIRY_DAYS * DAY_MS)
    );
  });

  it("is adjustable without touching the sweep itself", () => {
    const shorter = proposalExpiryCutoff(NOW, 1);
    const longer = proposalExpiryCutoff(NOW, 30);
    expect(shorter.getTime()).toBeGreaterThan(longer.getTime());
  });
});

describe("expireStaleProposals", () => {
  it("only considers proposals that are still pending and past the cutoff", async () => {
    await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: "pending",
          createdAt: { lt: new Date(NOW.getTime() - 7 * DAY_MS) },
        },
      })
    );
  });

  it("leaves an active proposal untouched", async () => {
    // Nothing matches the age filter, so nothing is swept.
    prisma.treasuryProposal.findMany.mockResolvedValue([]);

    const result = await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(result.expired).toBe(0);
    expect(prisma.treasuryProposal.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("moves a stale proposal to expired", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);

    const result = await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(result.expired).toBe(1);
    expect(prisma.treasuryProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proposal_1", status: "pending" },
        data: expect.objectContaining({ status: EXPIRED_STATUS }),
      })
    );
  });

  it("guards the update on the row still being pending", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);

    await expireStaleProposals({ now: NOW, ageDays: 7 });

    // The status predicate is what makes the sweep safe next to live signing.
    const args = prisma.treasuryProposal.updateMany.mock.calls[0][0];
    expect(args.where.status).toBe("pending");
  });

  it("does not count a proposal signed between the query and the write", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);
    // A signer reached threshold first: the conditional update matches nothing.
    prisma.treasuryProposal.updateMany.mockResolvedValue({ count: 0 });

    const result = await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(result.expired).toBe(0);
    // No audit record for a transition that did not happen.
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("writes the audit record in the same transaction as the status change", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);

    await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "treasury_proposal.expired",
          entityType: "treasury_proposal",
          entityId: "proposal_1",
          groupId: "group_1",
        }),
      })
    );
  });

  it("records the age that justified the transition", async () => {
    const createdAt = new Date(NOW.getTime() - 30 * DAY_MS);
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal({ createdAt })]);

    await expireStaleProposals({ now: NOW, ageDays: 7 });

    const data = prisma.auditLog.create.mock.calls[0][0].data;
    expect(data.metadata).toMatchObject({
      from: "pending",
      to: EXPIRED_STATUS,
      ageMs: 30 * DAY_MS,
      source: "worker",
    });
  });

  it("expires every stale proposal in the batch", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([
      proposal({ id: "proposal_1" }),
      proposal({ id: "proposal_2" }),
      proposal({ id: "proposal_3" }),
    ]);

    const result = await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(result.expired).toBe(3);
    expect(prisma.treasuryProposal.updateMany).toHaveBeenCalledTimes(3);
  });

  it("bounds the batch so a backlog cannot run unbounded", async () => {
    await expireStaleProposals({ now: NOW, ageDays: 7, batchSize: 10 });

    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 })
    );
  });

  it("works the oldest proposals first", async () => {
    await expireStaleProposals({ now: NOW, ageDays: 7 });

    expect(prisma.treasuryProposal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } })
    );
  });

  it("reports the cutoff it used", async () => {
    const result = await expireStaleProposals({ now: NOW, ageDays: 14 });

    expect(result.olderThan).toEqual(new Date(NOW.getTime() - 14 * DAY_MS));
  });

  it("records a reason on the expired row", async () => {
    prisma.treasuryProposal.findMany.mockResolvedValue([proposal()]);

    await expireStaleProposals({ now: NOW, ageDays: 7 });

    const args = prisma.treasuryProposal.updateMany.mock.calls[0][0];
    expect(args.data.failureReason).toEqual(expect.stringContaining("threshold"));
  });
});
