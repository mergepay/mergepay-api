/**
 * Treasury transaction signature-collector routes.
 *
 *   POST /api/treasury/proposals
 *     Admin submits an unsigned XDR (built externally) for the group's
 *     treasury account; the server stores it as a pending proposal.
 *   GET  /api/treasury/proposals/:id
 *     Read a single proposal, including signatures collected so far.
 *   POST /api/treasury/proposals/:id/signatures
 *     A group admin posts a signed fragment of that XDR; the server
 *     verifies the signature against the account's live signer weights and
 *     auto-submits to Horizon once the threshold is met.
 *
 * Complements the existing group-scoped `/groups/:groupId/treasury/proposals`
 * routes (src/routes/treasury-proposals.ts), which build their own payment
 * XDR server-side. This flow is for a transaction an admin has already built
 * elsewhere and only needs the backend to collect signatures for.
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import { requireAdmin, requireMembership } from "../services/access";
import { treasurySignaturesService } from "../services/treasury-signatures";
import { treasuryTxProposalCreateSchema } from "../validations/treasury";
import { serializeTreasuryTxProposal } from "../serializers";
import { audit } from "../services/audit";
import { AuditAction } from "../services/audit-actions";

const signatureBodySchema = z.object({
  signedXdr: z.string().min(1),
});

export default async function treasurySignatureRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- POST /api/treasury/proposals -------------------------------------
  //
  // The body is validated by the shared treasuryTxProposalCreateSchema
  // (src/validations/treasury.ts, issue #402): a treasury id (`treasuryId`,
  // or its legacy `groupId` alias), a parseable `xdr`, and an optional
  // bounded `description`.
  app.post(
    "/treasury/proposals",
    rateLimited("treasuryPropose"),
    async (req) => {
      const auth = requireUser(req);
      const body = treasuryTxProposalCreateSchema.parse(req.body);
      await requireAdmin(body.treasuryId, auth.id);

      const { proposal, networkPassphrase } =
        await treasurySignaturesService.createProposal({
          groupId: body.treasuryId,
          creatorId: auth.id,
          creatorPublicKey: auth.stellarPublicKey,
          xdr: body.xdr,
          description: body.description ?? null,
        });

      await audit({
        userId: auth.id,
        groupId: body.treasuryId,
        action: AuditAction.TREASURY_PROPOSAL_CREATED,
        entityType: "treasury_tx_proposal",
        entityId: proposal.id,
        outcome: "success",
        actorPublicKey: auth.stellarPublicKey,
        metadata: { description: body.description },
      });

      return {
        proposal: serializeTreasuryTxProposal(proposal),
        networkPassphrase,
      };
    }
  );

  // -- GET /api/treasury/proposals/:id -------------------------------------
  app.get("/treasury/proposals/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const proposal = await prisma.treasuryTxProposal.findUnique({
      where: { id },
      include: { signatures: true },
    });
    if (!proposal) throw Errors.notFound("Treasury proposal not found");
    await requireMembership(proposal.groupId, auth.id);

    return { proposal: serializeTreasuryTxProposal(proposal) };
  });

  // -- POST /api/treasury/proposals/:id/signatures --------------------------
  app.post(
    "/treasury/proposals/:id/signatures",
    rateLimited("treasurySubmit"),
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = signatureBodySchema.parse(req.body);

      const existing = await prisma.treasuryTxProposal.findUnique({
        where: { id },
        select: { groupId: true },
      });
      if (!existing) throw Errors.notFound("Treasury proposal not found");
      await requireAdmin(existing.groupId, auth.id);

      const result = await treasurySignaturesService.submitSignature({
        proposalId: id,
        groupId: existing.groupId,
        userId: auth.id,
        signedXdr: body.signedXdr,
      });

      // Audit the signature submission regardless of whether threshold was met
      await audit({
        userId: auth.id,
        groupId: existing.groupId,
        action: AuditAction.TREASURY_PROPOSAL_SIGNED,
        entityType: "treasury_tx_proposal",
        entityId: id,
        outcome: "success",
        actorPublicKey: auth.stellarPublicKey,
        metadata: {
          status: result.status,
          totalWeight: result.totalWeight,
          requiredWeight: result.requiredWeight,
          submitted: result.stellarTxHash ? true : false,
        },
      });

      // If auto-submitted, log that too
      if (result.stellarTxHash) {
        await audit({
          userId: auth.id,
          groupId: existing.groupId,
          action: AuditAction.TREASURY_PROPOSAL_SUBMITTED,
          entityType: "treasury_tx_proposal",
          entityId: id,
          outcome: "success",
          actorPublicKey: auth.stellarPublicKey,
          metadata: { stellarTxHash: result.stellarTxHash },
        });
      }

      const proposal = await prisma.treasuryTxProposal.findUnique({
        where: { id },
        include: { signatures: true },
      });

      return {
        proposal: serializeTreasuryTxProposal(proposal),
        status: result.status,
        totalWeight: result.totalWeight,
        requiredWeight: result.requiredWeight,
        stellarTxHash: result.stellarTxHash,
      };
    }
  );
}
