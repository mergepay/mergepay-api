import { FastifyInstance } from "fastify";
import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireAdmin, requireMembership } from "../services/access";
import { audit } from "../services/audit";
import { stellar } from "../services/stellar";
import {
  addSignature,
  buildPaymentXdr,
  checkThresholdAndSubmit,
  validateProposalXdr,
} from "../services/treasury";

const proposalStore = () => (prisma as any).treasuryProposal;

export default async function treasuryProposalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  app.post("/groups/:groupId/treasury/proposals", async (req, reply) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireAdmin(groupId, auth.id);

    const body = z
      .object({
        destination: z.string(),
        amount: z
          .string()
          .regex(/^([1-9]\d*)(\.\d{1,7})?$/, "Amount must be positive"),
        asset: z.object({
          code: z.string().min(1).max(12),
          issuer: z.string().nullable().optional(),
        }),
      })
      .parse(req.body);

    if (!StrKey.isValidEd25519PublicKey(body.destination)) {
      throw Errors.badRequest(
        "invalid_destination",
        "Invalid destination public key"
      );
    }
    if (body.asset.code === "XLM" && body.asset.issuer) {
      throw Errors.badRequest(
        "invalid_asset",
        "Native XLM cannot have an issuer"
      );
    }
    if (body.asset.code !== "XLM" && !body.asset.issuer) {
      throw Errors.badRequest(
        "invalid_asset",
        "Non-native assets require an issuer"
      );
    }
    if (
      body.asset.issuer &&
      !StrKey.isValidEd25519PublicKey(body.asset.issuer)
    ) {
      throw Errors.badRequest("invalid_asset", "Invalid asset issuer");
    }

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "treasury_disabled",
        "Treasury is not enabled"
      );
    }

    const xdr = await buildPaymentXdr(
      group.treasuryAccountPublicKey,
      body.destination,
      body.amount,
      { code: body.asset.code, issuer: body.asset.issuer ?? null }
    );

    const proposal = await proposalStore().create({
      data: {
        groupId,
        creatorId: auth.id,
        xdr,
        status: "pending",
        signatures: [],
      },
    });

    await audit({
      userId: auth.id,
      action: "treasury.proposal.create",
      entityType: "treasury_proposal",
      entityId: proposal.id,
      metadata: {
        destination: body.destination,
        amount: body.amount,
        asset: body.asset,
      },
    });

    return reply.status(201).send({
      proposal,
      unsignedXdr: xdr,
      networkPassphrase: config.networkPassphrase,
    });
  });

  app.get("/groups/:groupId/treasury/proposals", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const proposals = await proposalStore().findMany({
      where: { groupId },
      orderBy: { createdAt: "desc" },
    });

    return {
      proposals: proposals.map((proposal: any) => ({
        ...proposal,
        signatureCount: Array.isArray(proposal.signatures)
          ? proposal.signatures.length
          : 0,
      })),
    };
  });

  app.post(
    "/groups/:groupId/treasury/proposals/:proposalId/sign",
    async (req) => {
      const auth = requireUser(req);
      const { groupId, proposalId } = z
        .object({ groupId: z.string(), proposalId: z.string() })
        .parse(req.params);
      await requireMembership(groupId, auth.id);

      const body = z
        .object({ publicKey: z.string(), signature: z.string().min(1) })
        .parse(req.body);

      if (
        body.publicKey !== auth.stellarPublicKey ||
        !StrKey.isValidEd25519PublicKey(body.publicKey)
      ) {
        throw Errors.forbidden(
          "Signature key must belong to the authenticated member"
        );
      }

      const proposal = await proposalStore().findUnique({
        where: { id: proposalId },
      });
      if (!proposal || proposal.groupId !== groupId) {
        throw Errors.notFound("Treasury proposal not found");
      }
      if (proposal.status !== "pending") {
        throw Errors.conflict(
          "proposal_complete",
          "Proposal is no longer pending"
        );
      }

      const group = await prisma.group.findUnique({ where: { id: groupId } });
      if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
        throw Errors.badRequest(
          "treasury_disabled",
          "Treasury is not enabled"
        );
      }

      validateProposalXdr(proposal.xdr, group.treasuryAccountPublicKey);

      const signatures = (Array.isArray(proposal.signatures)
        ? proposal.signatures
        : []) as Array<{ publicKey: string; signature: string }>;
      if (signatures.some((item) => item.publicKey === body.publicKey)) {
        throw Errors.conflict(
          "duplicate_signature",
          "This member has already signed the proposal"
        );
      }

      const signedXdr = addSignature(
        proposal.xdr,
        body.publicKey,
        body.signature
      );
      const nextSignatures = [...signatures, body];
      const updated = await proposalStore().update({
        where: { id: proposal.id },
        data: { xdr: signedXdr, signatures: nextSignatures },
      });

      await audit({
        userId: auth.id,
        action: "treasury.proposal.sign",
        entityType: "treasury_proposal",
        entityId: proposal.id,
        metadata: { publicKey: body.publicKey },
      });

      const threshold = group.treasuryRequiredSigners ?? 1;
      if (nextSignatures.length < threshold) {
        return {
          proposal: updated,
          signatureCount: nextSignatures.length,
          threshold,
        };
      }

      try {
        const hash = await checkThresholdAndSubmit({
          xdr: signedXdr,
          signatures: nextSignatures,
          threshold,
        });
        const completed = await proposalStore().update({
          where: { id: proposal.id },
          data: { status: "submitted" },
        });
        await audit({
          userId: auth.id,
          action: "treasury.proposal.submit",
          entityType: "treasury_proposal",
          entityId: proposal.id,
          metadata: { hash },
        });
        return { proposal: completed, transactionHash: hash };
      } catch (error) {
        await proposalStore().update({
          where: { id: proposal.id },
          data: { status: "failed" },
        });
        throw error;
      }
    }
  );

  app.get("/groups/:groupId/treasury/status", async (req) => {
    const auth = requireUser(req);
    const { groupId } = z.object({ groupId: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const group = await prisma.group.findUnique({ where: { id: groupId } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest(
        "treasury_disabled",
        "Treasury is not enabled"
      );
    }

    const snapshot = await stellar.loadAccount(group.treasuryAccountPublicKey);
    return {
      publicKey: group.treasuryAccountPublicKey,
      balances: snapshot.balances,
      signers: snapshot.signers,
      thresholds: snapshot.thresholds,
      requiredSignatures: group.treasuryRequiredSigners ?? 1,
    };
  });
}
