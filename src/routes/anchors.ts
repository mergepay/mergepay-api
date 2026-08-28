import { FastifyInstance } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { anchorService, mapAnchorStatus } from "../services/anchor";
import { applyAnchorSessionTransition } from "../services/anchor-status";
import {
  applyWithdrawalTransition,
  mapAnchorStatusToWithdrawalStatus,
} from "../services/withdrawal-status";
import { auditTx } from "../services/audit";
import { rateLimited } from "../lib/rate-limit";
import { ipKey } from "../services/rate-limit-keys";
import {
  paginationQuerySchema,
  buildPage,
  cursorFilter,
  cursorOrderBy,
  requireCursor,
  takeForPage,
} from "../lib/pagination";
import { serializeAnchorSession } from "../serializers";
import { validateAsset } from "../services/assets";

export default async function anchorRoutes(app: FastifyInstance) {
  // Every anchor route that reaches an anchor gets an explicit budget so a
  // client cannot amplify one Mergepay request into unbounded upstream ones.
  //
  //  - anchorInit  — deposit/withdraw start and interactive completion. Each
  //    call fans out to stellar.toml + SEP-10 + SEP-24, so it is the tightest
  //    policy in the API.
  //  - anchorPoll  — status reads. Cheaper, but still upstream-amplifying (or,
  //    for the DB-backed session list, the endpoint clients poll in a loop).
  //
  // Both are keyed by the authenticated user, so one caller can never exhaust
  // another's budget. The webhook is keyed by IP because it is authenticated
  // by shared secret rather than a session.
  const initLimit = rateLimited("anchorInit");
  const pollLimit = rateLimited("anchorPoll");

  // -- list anchors (public-ish, but behind auth for consistency) -------------
  app.get(
    "/anchors",
    { preHandler: [app.authenticate], ...pollLimit },
    async () => {
    try {
      const t = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
      return {
        anchors: [
          {
            name: config.ANCHOR_NAME,
            homeDomain: config.ANCHOR_HOME_DOMAIN,
            assets: t.assets.length
              ? t.assets
              : [
                  { code: "SRT", issuer: null },
                  { code: config.STABLE_ASSET_CODE, issuer: config.STABLE_ASSET_ISSUER },
                ],
          },
        ],
      };
    } catch {
      // Fall back to a static descriptor if the toml can't be fetched.
      return {
        anchors: [
          {
            name: config.ANCHOR_NAME,
            homeDomain: config.ANCHOR_HOME_DOMAIN,
            assets: [
              { code: "SRT", issuer: null },
              { code: config.STABLE_ASSET_CODE, issuer: config.STABLE_ASSET_ISSUER },
            ],
          },
        ],
      };
    }
  }
  );

  // -- start deposit / withdraw -----------------------------------------------
  async function start(kind: "deposit" | "withdrawal", req: any) {
    const auth = requireUser(req);
    const body = z
      .object({ assetCode: z.string().min(1), anchorName: z.string().optional() })
      .parse(req.body);

    // Validate that the requested asset is supported.
    validateAsset(body.assetCode);

    const t = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
    const challenge = await anchorService.getChallenge(
      t.webAuthEndpoint,
      auth.stellarPublicKey
    );

    const session = await prisma.$transaction(async (tx) => {
      const created = await tx.anchorSession.create({
        data: {
          userId: auth.id,
          anchorName: body.anchorName ?? config.ANCHOR_NAME,
          kind,
          assetCode: body.assetCode,
          status: "incomplete",
        },
      });
      await auditTx(tx, {
        userId: auth.id,
        action: "anchor_session.start",
        entityType: "anchor_session",
        entityId: created.id,
        metadata: { kind, assetCode: body.assetCode },
      });
      return created;
    });

    return {
      session: serializeAnchorSession(session),
      challenge,
    };
  }

  app.post("/anchors/deposit", { preHandler: [app.authenticate], ...initLimit }, (req) =>
    start("deposit", req)
  );
  app.post("/anchors/withdraw", { preHandler: [app.authenticate], ...initLimit }, (req) =>
    start("withdrawal", req)
  );

  // -- complete (exchange signed challenge for interactive url) ---------------
  app.post(
    "/anchors/sessions/:id/complete",
    { preHandler: [app.authenticate], ...initLimit },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);

      const session = await prisma.anchorSession.findUnique({
        where: { id },
      });
      if (!session || session.userId !== auth.id) {
        throw Errors.notFound("Anchor session not found");
      }

      const t = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
      const token = await anchorService.getToken(t.webAuthEndpoint, body.signedXdr);
      const interactive = await anchorService.startInteractive({
        transferServer: t.transferServerSep24,
        token,
        kind: session.kind as "deposit" | "withdrawal",
        assetCode: session.assetCode,
        account: auth.stellarPublicKey,
      });

      // Never store the anchor JWT alongside the transition's audit
      // metadata — only the status change and its source are recorded.
      const { session: updated } = await applyAnchorSessionTransition({
        sessionId: id,
        nextStatus: "pending_user_transfer_start",
        source: "user",
        ownerUserId: auth.id,
        extraData: {
          interactiveUrl: interactive.url,
          externalTransactionId: interactive.id,
          anchorToken: token,
        },
      });

      return { session: serializeAnchorSession(updated) };
    }
  );

  // -- sessions ---------------------------------------------------------------
  app.get("/anchors/sessions", { preHandler: [app.authenticate] }, async (req) => {
    const auth = requireUser(req);
    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    const position = requireCursor(cursor);

    const sessions = await prisma.anchorSession.findMany({
      where: {
        userId: auth.id,
        ...cursorFilter(position, order),
      },
      orderBy: cursorOrderBy(order),
      take: takeForPage(limit),
    });

    const { items, meta } = buildPage(sessions, limit, order);

    return {
      sessions: items.map(serializeAnchorSession),
      meta,
    };
  });

  // -- webhook (signed) -------------------------------------------------------
  // Rate limiting here is abuse protection for an unauthenticated-until-
  // checked endpoint; it never substitutes for the shared-secret check
  // below, which remains the actual authentication/authorization gate.
  app.post(
    "/anchors/webhook",
    {
      config: {
        rateLimit: {
          max: config.SEP24_RATE_LIMIT_MAX,
          timeWindow: config.RATE_LIMIT_WINDOW_MS,
          keyGenerator: ipKey("anchor.webhook"),
        },
      },
    },
    async (req, reply) => {
      const secret = (req.headers["x-anchor-signature"] ??
        req.headers["x-webhook-secret"]) as string | undefined;
      if (!secret || !constantTimeEqual(secret, config.ANCHOR_WEBHOOK_SECRET)) {
        return reply.code(200).send({ ok: true }); // don't reveal verification result
      }
      const body = z
        .object({
          transaction: z
            .object({ id: z.string(), status: z.string() })
            .optional(),
          id: z.string().optional(),
          status: z.string().optional(),
        })
        .passthrough()
        .parse(req.body ?? {});

      const externalId = body.transaction?.id ?? body.id;
      const status = body.transaction?.status ?? body.status;
      if (externalId && status) {
        const mappedStatus = mapAnchorStatus(status);
        const sessions = await prisma.anchorSession.findMany({
          where: { externalTransactionId: externalId },
        });
        for (const session of sessions) {
          // applyAnchorSessionTransition atomically validates the transition
          // against the finite state map and writes its audit record in the
          // same database transaction as the status change — see
          // src/services/anchor-status.ts. An out-of-order or duplicate
          // webhook delivery is a no-op rather than a regression.
          await applyAnchorSessionTransition({
            sessionId: session.id,
            nextStatus: mappedStatus,
            source: "webhook",
          });
        }

        // The simpler `Withdrawal` record (POST /withdraw) is a separate
        // table keyed by the same anchor transaction id — see
        // src/services/withdrawal-status.ts for why it has its own status
        // vocabulary and transition map.
        const withdrawal = await (prisma as any).withdrawal.findUnique({
          where: { anchorTxId: externalId },
        });
        if (withdrawal) {
          await applyWithdrawalTransition({
            withdrawalId: withdrawal.id,
            nextStatus: mapAnchorStatusToWithdrawalStatus(mappedStatus),
            source: "webhook",
          });
        }
      }
      return reply.code(200).send({ ok: true });
    }
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
