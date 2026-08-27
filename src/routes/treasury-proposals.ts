/**
 * Treasury multisig proposal routes — Issue #41.
 *
 *   POST   /groups/:groupId/treasury/proposals
 *     Admin creates a payment proposal; backend builds the unsigned XDR.
 *   GET    /groups/:groupId/treasury/proposals
 *     List proposals with status & signature count.
 *   POST   /groups/:groupId/treasury/proposals/:proposalId/sign
 *     Member posts their signed XDR; backend verifies the signature,
 *     appends to the proposal, and auto-submits when threshold is met.
 *   GET    /groups/:groupId/treasury/status
 *     Return treasury multisig account info (balance, signers, threshold).
 *     Same data as the existing `/groups/:id/treasury` route, exposed under
 *     the path the issue spec requests.
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";
import { isPositive } from "../services/money";
import {
  serializeGroup,
  serializeTreasuryProposal,
} from "../serializers";
import { treasuryProposalsService } from "../services/treasury-proposals";

const createBodySchema = z.object({
  destination: z.string().min(1),
  amount: z.string().min(1),
  assetCode: z.string().min(1),
  assetIssuer: z.string().nullable().optional(),
  memo: z.string().min(1).max(28).optional(),
});

const signBodySchema = z.object({
  signedXdr: z.string().min(1),
});

export default async function treasuryProposalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- POST /groups/:groupId/treasury/proposals -------------------------------
  app.post("/groups/:groupId/treasury/proposals", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireAdmin(groupId, auth.id);
    const body = createBodySchema.parse(req.body);

    if (!isPositive(body.amount)) {
      throw Errors.badRequest("invalid_amount", "Amount must be positive");
    }
    if (!StrKey.isValidEd25519PublicKey(body.destination)) {
      throw Errors.badRequest(
        "invalid_destination",
        "Destination must be a valid Stellar public key"
      );
    }
    if (body.assetIssuer && !StrKey.isValidEd25519PublicKey(body.assetIssuer)) {
      throw Errors.badRequest(
        "invalid_asset_issuer",
        "assetIssuer must be a valid Stellar public key when supplied"
      );
    }

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "treasury_disabled",
        "Treasury is not enabled for this group"
      );
    }

    const threshold = group.treasuryRequiredSigners ?? 1;

    const { proposal, xdr, networkPassphrase } =
      await treasuryProposalsService.create(
        {
          groupId,
          creatorId: auth.id,
          creatorPublicKey: auth.stellarPublicKey,
          destination: body.destination,
          amount: body.amount,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          memo: body.memo ?? null,
        },
        threshold
      );

    await audit({
      userId: auth.id,
      action: "treasury.proposal.created",
      entityType: "treasury_proposal",
      entityId: proposal.id,
      metadata: {
        groupId,
        destination: body.destination,
        amount: body.amount,
        assetCode: body.assetCode,
        threshold,
      },
    });

    return {
      proposal: serializeTreasuryProposal(proposal),
      xdr,
      networkPassphrase,
    };
  });

  // -- GET /groups/:groupId/treasury/proposals --------------------------------
  app.get("/groups/:groupId/treasury/proposals", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const proposals = await prisma.treasuryProposal.findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });
    return { proposals: proposals.map(serializeTreasuryProposal) };
  });

  // -- POST /groups/:groupId/treasury/proposals/:proposalId/sign --------------
  app.post(
    "/groups/:groupId/treasury/proposals/:proposalId/sign",
    async (req) => {
      const auth = requireUser(req);
      const { groupId, proposalId } = z
        .object({ groupId: z.string(), proposalId: z.string() })
        .parse(req.params);
      await requireMembership(groupId, auth.id);
      // The service enforces the persisted proposal/group relationship. Keep
      // authorization based on the authenticated member and requested group,
      // without performing a second resource lookup that changes legacy error
      // behavior for proposal-state validation.
      const body = signBodySchema.parse(req.body);

      // Load group members to constrain which signers are accepted.
      const members = await prisma.groupMember.findMany({
        where: { groupId },
        include: { user: true },
      });
      const memberPublicKeys = members.map((m) => m.user.stellarPublicKey);

      const result = await treasuryProposalsService.submitSignatures({
        proposalId,
        groupId,
        memberPublicKeys,
        signedXdr: body.signedXdr,
        userId: auth.id,
      });

      await audit({
        userId: auth.id,
        action:
          result.status === "confirmed"
            ? "treasury.proposal.submitted"
            : "treasury.proposal.signed",
        entityType: "treasury_proposal",
        entityId: proposalId,
        metadata: {
          signatureCount: result.signatureCount,
          threshold: result.threshold,
          stellarTxHash: result.stellarTxHash,
        },
      });

      const proposal = await prisma.treasuryProposal.findUnique({
        where: { id: proposalId },
      });
      return {
        proposal: serializeTreasuryProposal(proposal),
        signatureCount: result.signatureCount,
        threshold: result.threshold,
        status: result.status,
        stellarTxHash: result.stellarTxHash,
      };
    }
  );

  // -- GET /groups/:groupId/treasury/status -----------------------------------
  app.get("/groups/:groupId/treasury/status", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "treasury_disabled",
        "Treasury is not enabled for this group"
      );
    }

    const snapshot = await stellar.loadAccount(group.treasuryAccountPublicKey);
    return {
      group: serializeGroup(group),
      publicKey: group.treasuryAccountPublicKey,
      balances: snapshot.balances.map((b) => ({
        assetCode: b.assetCode,
        assetIssuer: b.assetIssuer,
        balance: b.balance,
      })),
      signers: snapshot.signers,
      thresholds: snapshot.thresholds,
      requiredSigners: group.treasuryRequiredSigners ?? 1,
      networkPassphrase: config.networkPassphrase,
    };
  });
}
