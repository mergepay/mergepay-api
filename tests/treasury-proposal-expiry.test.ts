import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    treasuryProposal: {
      findUnique: vi.fn(),
      findMany: vi.fn(async () => []),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
    },
    treasuryApproval: { findMany: vi.fn(async () => []) },
    groupMember: { findMany: vi.fn(async () => []) },
    auditLog: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(),
    submitPayment: vi.fn(),
    submitSigned: vi.fn(),
  },
}));

import {
  assertProposalActionable,
  isProposalExpired,
  proposalExpiryDate,
  treasuryProposalExpiryDaysSchema,
} from "../src/services/treasury-proposal-expiry";
import { treasuryProposalsService } from "../src/services/treasury-proposals";
import { serializeTreasuryProposal } from "../src/serializers";

const prisma = h.prisma;
const NOW = new Date("2026-06-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("treasury proposal expiry bounds", () => {
  it("defaults to seven days", () => {
    expect(proposalExpiryDate(undefined, NOW)).toEqual(
      new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000)
    );
  });

  it("accepts overrides only inside sane bounds", () => {
    expect(treasuryProposalExpiryDaysSchema.parse(undefined)).toBe(7);
    expect(treasuryProposalExpiryDaysSchema.parse(2)).toBe(2);
    expect(() => treasuryProposalExpiryDaysSchema.parse(0)).toThrow();
    expect(() => treasuryProposalExpiryDaysSchema.parse(31)).toThrow();
  });

  it("detects a backdated expiry and falls back to creation time on legacy rows", () => {
    expect(
      isProposalExpired(
        { status: "pending", expiresAt: new Date(NOW.getTime() - 1000) },
        NOW
      )
    ).toBe(true);
    expect(
      isProposalExpired(
        { status: "pending", createdAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) },
        NOW
      )
    ).toBe(true);
    expect(
      isProposalExpired(
        { status: "pending", expiresAt: new Date(NOW.getTime() + 1000) },
        NOW
      )
    ).toBe(false);
  });
});

describe("assertProposalActionable", () => {
  it("throws a conflict for an expired proposal", () => {
    expect(() =>
      assertProposalActionable(
        { status: "pending", expiresAt: new Date(NOW.getTime() - 1000) },
        NOW
      )
    ).toThrow(/expired/);
  });

  it("allows an open proposal inside its window", () => {
    expect(() =>
      assertProposalActionable(
        { status: "pending", expiresAt: new Date(NOW.getTime() + 1000) },
        NOW
      )
    ).not.toThrow();
  });
});

describe("expired proposal writes", () => {
  const expired = {
    id: "proposal_1",
    groupId: "group_1",
    creatorId: "user_1",
    xdr: "unused",
    txHash: "hash",
    threshold: 1,
    signatures: [],
    status: "pending",
    expiresAt: new Date(NOW.getTime() - 1000),
    createdAt: new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000),
  };

  it("rejects signing an expired proposal", async () => {
    prisma.treasuryProposal.findUnique.mockResolvedValue(expired);

    await expect(
      treasuryProposalsService.submitSignatures({
        proposalId: expired.id,
        groupId: expired.groupId,
        memberPublicKeys: [],
        signedXdr: "anything",
        userId: "user_1",
      })
    ).rejects.toThrow(/expired/);

    expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("rejects submitting an expired proposal", async () => {
    prisma.treasuryProposal.findUnique.mockResolvedValue(expired);

    await expect(
      treasuryProposalsService.mergeAndSubmit(prisma, expired.id, [], null, "user_1")
    ).rejects.toThrow(/expired/);

    expect(prisma.treasuryProposal.update).not.toHaveBeenCalled();
  });

  it("flags an expired proposal as not actionable when serialized", () => {
    const serialized = serializeTreasuryProposal({
      ...expired,
      updatedAt: NOW,
    });

    expect(serialized.status).toBe("pending");
    expect(serialized.actionable).toBe(false);
    expect(serialized.expiresAt).toBe(expired.expiresAt.toISOString());
  });
});
