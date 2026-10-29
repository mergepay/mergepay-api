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
import { openApiBody, openApiIdParams, openApiEnvelope, openApiErrorResponses } from "../lib/openapi";

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
    {
      ...rateLimited("treasuryPropose"),
      schema: {
        tags: ["Treasury"],
        summary: "Submit external treasury proposal with rate limiting",
        description:
          "Records an externally built, unsigned Stellar transaction that spends from the group treasury. Rate limited under treasuryPropose policy (#803).",
        body: openApiBody(treasuryTxProposalCreateSchema, { enforce: false }),
        response: {
          ...openApiEnvelope("proposal"),
          ...openApiErrorResponses(400, 401, 403, 404, 429),
        },
      },
    },
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

      // The service writes the `treasury.tx_proposal.created` audit row inside
      // the same transaction as the proposal insert. Do not add a second,
      // best-effort record here: it would duplicate the event under the
      // server-built-proposal action vocabulary and could disagree with the
      // durable row if the two writes straddle a failure.

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
    {
      ...rateLimited("treasurySubmit"),
      schema: {
        tags: ["Treasury"],
        summary: "Submit signature for treasury proposal with rate limiting",
        description:
          "Submits a signed fragment for a pending treasury proposal. Rate limited under treasurySubmit policy (#803).",
        params: openApiIdParams(),
        body: openApiBody(signatureBodySchema, { enforce: false }),
        response: {
          ...openApiErrorResponses(400, 401, 403, 404, 409, 429),
        },
      },
    },
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
        // The verified session's public key, so the audit row for the
        // threshold/submission transitions names the caller who acted.
        actorPublicKey: auth.stellarPublicKey,
        signedXdr: body.signedXdr,
      });

      // Signature, threshold, and submission audit rows are written by the
      // service inside the signature transaction (signature_added, ready,
      // submitted/failed). Re-logging them here would double-count the same
      // action and record a submission under the wrong flow's action name.

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
