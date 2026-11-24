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
import { prisma } from "../db";
import { rateLimited } from "../lib/rate-limit";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { stellar } from "../services/stellar";
import { openApiBody } from "../lib/openapi";
import {
  treasuryProposalCreateSchema,
  treasuryProposalGroupParamsSchema,
  treasuryProposalParamsSchema,
  treasuryProposalSignSchema,
} from "../validations/treasury";
import {
  serializeGroup,
  serializeTreasuryProposal,
} from "../serializers";
import { treasuryProposalsService } from "../services/treasury-proposals";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";

export default async function treasuryProposalRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- POST /groups/:groupId/treasury/proposals -------------------------------
  app.post(
    "/groups/:groupId/treasury/proposals",
    {
      ...rateLimited("treasuryPropose"),
      schema: {
        tags: ["Treasury"],
        summary: "Create treasury proposal",
        description:
          "Creates a payment proposal and returns the unsigned XDR required for multisig approval.",
        body: openApiBody(treasuryProposalCreateSchema),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { groupId } = treasuryProposalGroupParamsSchema.parse(req.params);
    await requireAdmin(groupId, auth.id);
    const body = treasuryProposalCreateSchema.parse(req.body);

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

    return {
      proposal: serializeTreasuryProposal(proposal),
      xdr,
      networkPassphrase,
    };
  });

  // -- GET /groups/:groupId/treasury/proposals --------------------------------
  //
  // Paginated on the shared cursor convention (src/lib/pagination.ts). A
  // treasury accumulates proposals indefinitely — every payment a group has
  // ever proposed, signed or abandoned — so an unbounded read grew without
  // limit with the group's age and loaded the whole history to render a screen
  // that shows the most recent few.
  //
  // Membership is checked before any row is read, and the `groupId` filter is
  // what scopes the page. The cursor only moves where a page starts inside
  // that already-authorized scope; it never widens it.
  app.get(
    "/groups/:groupId/treasury/proposals",
    {
      schema: {
        tags: ["Treasury"],
        summary: "List treasury proposals",
        description: "Returns treasury proposals for a group, paginated by cursor.",
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { groupId } = treasuryProposalGroupParamsSchema.parse(req.params);
    await requireMembership(groupId, auth.id);

    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    const position = requireCursor(cursor);

    const proposals = await prisma.treasuryProposal.findMany({
      where: { groupId, ...cursorFilter(position, order) },
      orderBy: cursorOrderBy(order),
      take: takeForPage(limit),
    });

    const { items, meta } = buildPage(proposals, limit, order);
    return { proposals: items.map(serializeTreasuryProposal), meta };
  });

  // -- POST /groups/:groupId/treasury/proposals/:proposalId/sign --------------
  app.post(
    "/groups/:groupId/treasury/proposals/:proposalId/sign",
    {
      ...rateLimited("treasurySubmit"),
      schema: {
        tags: ["Treasury"],
        summary: "Sign treasury proposal",
        description:
          "Verifies a member's signature on a proposal and auto-submits it when the threshold is met.",
        body: openApiBody(treasuryProposalSignSchema),
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { groupId, proposalId } = treasuryProposalParamsSchema.parse(
        req.params
      );
      await requireMembership(groupId, auth.id);
      // The service enforces the persisted proposal/group relationship. Keep
      // authorization based on the authenticated member and requested group,
      // without performing a second resource lookup that changes legacy error
      // behavior for proposal-state validation.
      const body = treasuryProposalSignSchema.parse(req.body);

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

      // The service writes signature/submission audit records inside its
      // transaction; do not add a second best-effort record after commit.

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
  app.get(
    "/groups/:groupId/treasury/status",
    {
      schema: {
        tags: ["Treasury"],
        summary: "Get treasury status",
        description: "Returns treasury balances, signers, and thresholds for a group.",
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { groupId } = treasuryProposalGroupParamsSchema.parse(req.params);
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
