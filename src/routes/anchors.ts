import { FastifyInstance } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { anchorService, mapAnchorStatus } from "../services/anchor";
import { applyAnchorSessionTransition } from "../services/anchor-status";
import { audit } from "../services/audit";
import { ipKey } from "../services/rate-limit-keys";
import { serializeAnchorSession } from "../serializers";
import { validateAsset } from "../services/assets";
import { paginationQuerySchema, encodeCursor, decodeCursor } from "../lib/pagination";
import { recordStatusTransition } from "../services/status-history";

export default async function anchorRoutes(app: FastifyInstance) {
  // -- list anchors (public-ish, but behind auth for consistency) -------------
  app.get("/anchors", { preHandler: [app.authenticate] }, async () => {
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
  });

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

    const session = await prisma.anchorSession.create({
      data: {
        userId: auth.id,
        anchorName: body.anchorName ?? config.ANCHOR_NAME,
        kind,
        assetCode: body.assetCode,
        status: "incomplete",
      },
    });
    await audit({
      userId: auth.id,
      action: `anchor.${kind}.start`,
      entityType: "anchor_session",
      entityId: session.id,
    });

    return {
      session: serializeAnchorSession(session),
      challenge,
    };
  }

  app.post("/anchors/deposit", { preHandler: [app.authenticate] }, (req) =>
    start("deposit", req)
  );
  app.post("/anchors/withdraw", { preHandler: [app.authenticate] }, (req) =>
    start("withdrawal", req)
  );

  // -- complete (exchange signed challenge for interactive url) ---------------
  app.post(
    "/anchors/sessions/:id/complete",
    { preHandler: [app.authenticate] },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);

      const session = await prisma.anchorSession.findUnique({ 
        where: { id },
        include: { statusHistory: true },
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
    const { cursor, limit } = paginationQuerySchema.parse(req.query ?? {});

    let decodedCursor = null;
    if (cursor) {
      decodedCursor = decodeCursor(cursor);
      if (!decodedCursor) {
        throw Errors.badRequest("invalid_cursor", "The provided cursor is invalid");
      }
    }

    const sessions = await prisma.anchorSession.findMany({
      where: {
        userId: auth.id,
        ...(decodedCursor && {
          OR: [
            { createdAt: { lt: decodedCursor.createdAt } },
            {
              createdAt: decodedCursor.createdAt,
              id: { lt: decodedCursor.id },
            },
          ],
        }),
      },
      include: { statusHistory: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = sessions.length > limit;
    const results = hasMore ? sessions.slice(0, limit) : sessions;
    const nextCursor = hasMore
      ? encodeCursor(
          results[results.length - 1].createdAt,
          results[results.length - 1].id
        )
      : null;

    return {
      sessions: results.map(serializeAnchorSession),
      meta: { nextCursor, hasMore },
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
        await prisma.$transaction(async (tx) => {
          const sessions = await tx.anchorSession.findMany({
            where: { externalTransactionId: externalId },
          });
          for (const session of sessions) {
            await tx.anchorSession.update({
              where: { id: session.id },
              data: { status: mappedStatus },
            });
            await recordStatusTransition({
              entityType: "anchor_session",
              entityId: session.id,
              newStatus: mappedStatus,
              source: "anchor_webhook",
            });
          }
        });
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
