/**
 * Treasury multisig proposal and co-signature routes (issue #657).
 *
 *   POST /treasury/propose
 *     A group admin submits an unsigned transaction envelope, built outside the
 *     backend, that spends from the group's treasury account. The server stores
 *     it as a `TreasuryTxProposal` bound to that envelope's hash.
 *   POST /treasury/:id/sign
 *     An authorized co-signer posts the same envelope carrying their signature.
 *     Signatures are verified against the treasury account's *live* signer
 *     weights, and the merged transaction is submitted to Horizon once the
 *     account's high threshold is met.
 *
 * Both handlers are deliberately thin. The security-relevant invariants — hash
 * binding, live-weight signer attribution, row-locked threshold decisions, and
 * an audit row written inside the same transaction as the state change — already
 * live in `treasurySignaturesService`, and this route pair delegates to it rather
 * than restating them. No handler here reads, accepts, or stores key material;
 * only signatures already present on a submitted envelope are ever inspected.
 *
 * The same workflow is reachable as `/api/treasury/proposals*`
 * (src/routes/treasury-signatures.ts) under collection-style paths. These two
 * are the paths the treasury flow documents, so a client can propose and sign
 * without learning two path shapes.
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import { requireAdmin } from "../services/access";
import { treasurySignaturesService } from "../services/treasury-signatures";
import {
  treasurySignatureSubmitSchema,
  treasuryTxProposalCreateSchema,
} from "../validations/treasury";
import { serializeTreasuryTxProposal } from "../serializers";
import {
  openApiBody,
  openApiEnvelope,
  openApiErrorResponses,
  openApiIdParams,
  openApiResponse,
} from "../lib/openapi";

/** Path params for `POST /treasury/:id/sign`. */
const proposalParamsSchema = z.object({
  id: z.string().min(1).max(64, "Proposal id is too long"),
});

export default async function treasuryMultisigRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- POST /treasury/propose ----------------------------------------------
  app.post(
    "/treasury/propose",
    {
      ...rateLimited("treasuryPropose"),
      schema: {
        tags: ["Treasury"],
        summary: "Propose a treasury multisig transaction",
        description:
          "Records an externally built, unsigned Stellar transaction that spends from the group's treasury account, and returns it as a pending proposal bound to its own transaction hash. Only a group admin may propose. The envelope must parse, carry no signatures, and be sourced from the configured treasury account.",
        body: openApiBody(treasuryTxProposalCreateSchema, { enforce: false }),
        response: {
          ...openApiEnvelope("proposal"),
          ...openApiErrorResponses(400, 401, 403, 404, 429),
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      // The shared schema is the whole request contract: `treasuryId` (or its
      // legacy `groupId` alias), a parseable `xdr`, an optional bounded
      // `description`. Unknown fields are stripped, so nothing outside this
      // shape can reach the stored row.
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

      return {
        proposal: serializeTreasuryTxProposal(proposal),
        networkPassphrase,
      };
    }
  );

  // -- POST /treasury/:id/sign ---------------------------------------------
  app.post(
    "/treasury/:id/sign",
    {
      ...rateLimited("treasurySubmit"),
      schema: {
        tags: ["Treasury"],
        summary: "Co-sign a treasury multisig transaction",
        description:
          "Adds the caller's signature to a pending treasury proposal. The submitted envelope must hash to the proposal's stored transaction, and every signature on it must verify against a group admin whose key still holds positive signing weight on the treasury account. Once the collected weight reaches the account's live high threshold the merged transaction is submitted to Horizon; a proposal in a terminal state answers 409.",
        params: openApiIdParams(),
        body: openApiBody(treasurySignatureSubmitSchema, { enforce: false }),
        response: {
          ...openApiResponse(
            {
              proposal: { type: "object", additionalProperties: true },
              status: { type: "string" },
              totalWeight: { type: "number" },
              requiredWeight: { type: "number" },
              stellarTxHash: { type: ["string", "null"] },
            },
            ["status", "totalWeight", "requiredWeight"]
          ),
          ...openApiErrorResponses(400, 401, 403, 404, 409, 429),
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = proposalParamsSchema.parse(req.params);
      const { signedXdr } = treasurySignatureSubmitSchema.parse(req.body);

      // The proposal's group — not the caller's claim — decides who is
      // authorized, so a signed envelope for someone else's treasury cannot be
      // pushed through by guessing a proposal id.
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
        signedXdr,
      });

      const proposal = await prisma.treasuryTxProposal.findUnique({
        where: { id },
        include: { signatures: true },
      });
      if (!proposal) throw Errors.notFound("Treasury proposal not found");

      return {
        proposal: serializeTreasuryTxProposal(proposal),
        ...result,
      };
    }
  );
}
