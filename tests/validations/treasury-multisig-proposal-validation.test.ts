import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(async ({ data }: any) => ({ ...data })),
    count: vi.fn(async () => 0),
  });

  const prisma: any = {
    group: model(),
    groupMember: model(),
    treasuryProposal: model(),
    auditLog: model(),
    $transaction: vi.fn(async (fn: any) =>
      typeof fn === "function" ? fn(h.prisma) : Promise.all(fn)
    ),
  };

  const createProposal = vi.fn(async () => ({
    proposal: {
      id: "prop_123",
      groupId: "group_proposal_val_test",
      creatorId: "user_admin_prop",
      status: "pending",
      threshold: 2,
      signatures: [],
      xdr: "AAAA...",
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    xdr: "AAAA...",
    networkPassphrase: "Test SDF Network ; September 2015",
  }));

  return { prisma, createProposal };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));
vi.mock("../../src/services/treasury-proposals", () => ({
  treasuryProposalsService: {
    create: h.createProposal,
  },
}));

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import {
  treasuryMultisigProposalPayloadSchema,
  treasuryAmountSchema,
} from "../../src/validations/treasury";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const GROUP_ID = "group_proposal_val_test";
const ADMIN_ID = "user_admin_prop";
const VALID_DESTINATION = Keypair.random().publicKey();
const VALID_ISSUER = Keypair.random().publicKey();

function authHeader(userId = ADMIN_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: VALID_DESTINATION })}`,
  };
}

describe("Treasury Multisig Proposal Payload Validation (#874)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();

    prisma.group.findUnique.mockResolvedValue({
      id: GROUP_ID,
      treasuryEnabled: true,
      treasuryAccountPublicKey: Keypair.random().publicKey(),
      treasuryRequiredSigners: 2,
    });

    prisma.groupMember.findFirst.mockResolvedValue({
      id: "membership_admin",
      userId: ADMIN_ID,
      groupId: GROUP_ID,
      role: "admin",
    });

    prisma.groupMember.findUnique.mockResolvedValue({
      id: "membership_admin",
      userId: ADMIN_ID,
      groupId: GROUP_ID,
      role: "admin",
    });
  });

  describe("treasuryAmountSchema", () => {
    it("accepts positive integer and decimal strings", () => {
      expect(treasuryAmountSchema.parse("100")).toBe("100");
      expect(treasuryAmountSchema.parse("0.5")).toBe("0.5");
      expect(treasuryAmountSchema.parse("12.3456789")).toBe("12.3456789");
    });

    it("rejects zero and negative amounts", () => {
      expect(() => treasuryAmountSchema.parse("0")).toThrow();
      expect(() => treasuryAmountSchema.parse("-10")).toThrow();
    });

    it("rejects non-numeric characters", () => {
      expect(() => treasuryAmountSchema.parse("abc")).toThrow();
      expect(() => treasuryAmountSchema.parse("100 USDC")).toThrow();
    });
  });

  describe("treasuryMultisigProposalPayloadSchema", () => {
    it("validates a complete valid native XLM payment proposal", () => {
      const payload = {
        destination: VALID_DESTINATION,
        amount: "50.00",
        assetCode: "XLM",
        memo: "MP:March distributions",
      };

      const parsed = treasuryMultisigProposalPayloadSchema.parse(payload);
      expect(parsed.destination).toBe(VALID_DESTINATION);
      expect(parsed.amount).toBe("50.00");
      expect(parsed.assetCode).toBe("XLM");
    });

    it("validates a non-native asset proposal when assetIssuer is provided", () => {
      const payload = {
        destination: VALID_DESTINATION,
        amount: "250.75",
        assetCode: "USDC",
        assetIssuer: VALID_ISSUER,
      };

      const parsed = treasuryMultisigProposalPayloadSchema.parse(payload);
      expect(parsed.assetCode).toBe("USDC");
      expect(parsed.assetIssuer).toBe(VALID_ISSUER);
    });

    it("rejects non-native asset proposal when assetIssuer is missing", () => {
      const payload = {
        destination: VALID_DESTINATION,
        amount: "100.00",
        assetCode: "USDC",
      };

      expect(() => treasuryMultisigProposalPayloadSchema.parse(payload)).toThrow(
        "assetIssuer is required for non-native assets"
      );
    });

    it("rejects proposal when destination is malformed", () => {
      const payload = {
        destination: "NOT_A_VALID_STELLAR_ADDRESS",
        amount: "10.00",
        assetCode: "XLM",
      };

      expect(() => treasuryMultisigProposalPayloadSchema.parse(payload)).toThrow();
    });

    it("rejects proposal when amount is negative or invalid", () => {
      const payload = {
        destination: VALID_DESTINATION,
        amount: "-50.00",
        assetCode: "XLM",
      };

      expect(() => treasuryMultisigProposalPayloadSchema.parse(payload)).toThrow();
    });

    it("validates optional signers roster with valid weights", () => {
      const signerKey = Keypair.random().publicKey();
      const payload = {
        destination: VALID_DESTINATION,
        amount: "100.00",
        assetCode: "XLM",
        signers: [{ publicKey: signerKey, weight: 10 }],
        threshold: 10,
      };

      const parsed = treasuryMultisigProposalPayloadSchema.parse(payload);
      expect(parsed.signers).toHaveLength(1);
      expect(parsed.signers?.[0].publicKey).toBe(signerKey);
      expect(parsed.signers?.[0].weight).toBe(10);
    });
  });

  describe("API Route Integration: POST /groups/:groupId/treasury/proposals", () => {
    it("returns 200 with generated proposal when valid payload is submitted", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${GROUP_ID}/treasury/proposals`,
        headers: authHeader(),
        payload: {
          destination: VALID_DESTINATION,
          amount: "75.00",
          assetCode: "XLM",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().proposal).toBeDefined();
      expect(h.createProposal).toHaveBeenCalledTimes(1);
    });

    it("returns 400 VALIDATION_ERROR when destination address is invalid", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${GROUP_ID}/treasury/proposals`,
        headers: authHeader(),
        payload: {
          destination: "MALFORMED_G_ADDRESS",
          amount: "75.00",
          assetCode: "XLM",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      expect(h.createProposal).not.toHaveBeenCalled();
    });

    it("returns 400 VALIDATION_ERROR when amount is zero or negative", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${GROUP_ID}/treasury/proposals`,
        headers: authHeader(),
        payload: {
          destination: VALID_DESTINATION,
          amount: "0",
          assetCode: "XLM",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      expect(h.createProposal).not.toHaveBeenCalled();
    });

    it("rejects unexpected fields with structured validation details", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${GROUP_ID}/treasury/proposals`,
        headers: authHeader(),
        payload: {
          destination: VALID_DESTINATION,
          amount: "75.00",
          assetCode: "XLM",
          secret: Keypair.random().secret(),
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      expect(res.json().error.details).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: "secret", path: "secret" })])
      );
      expect(res.json().error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unrecognized_keys",
            message: expect.stringContaining("secret"),
          }),
        ])
      );
      expect(h.createProposal).not.toHaveBeenCalled();
    });

    it("accepts expiresInDays as part of the strict body contract", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/groups/${GROUP_ID}/treasury/proposals`,
        headers: authHeader(),
        payload: {
          destination: VALID_DESTINATION,
          amount: "75.00",
          assetCode: "XLM",
          expiresInDays: 14,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(h.createProposal).toHaveBeenCalledWith(
        expect.objectContaining({ expiresInDays: 14 }),
        2
      );
    });
  });
});
