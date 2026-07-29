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
import { serializeAnchorSession } from "../serializers";

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

      const session = await prisma.anchorSession.findUnique({ where: { id } });
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
    const sessions = await prisma.anchorSession.findMany({
      where: { userId: auth.id },
      orderBy: { createdAt: "desc" },
    });
    return { sessions: sessions.map(serializeAnchorSession) };
  });

  // -- webhook (signed) -------------------------------------------------------
  app.post("/anchors/webhook", async (req, reply) => {
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
      const nextStatus = mapAnchorStatus(status);
      // externalTransactionId is anchor-assigned per session; there is
      // ordinarily exactly one match, but iterate defensively rather than
      // assuming uniqueness at the database level.
      const sessions = await prisma.anchorSession.findMany({
        where: { externalTransactionId: externalId },
        select: { id: true },
      });
      for (const { id: sessionId } of sessions) {
        // Duplicate deliveries and invalid regressions (e.g. a stale
        // "pending_anchor" arriving after "completed") are silently ignored
        // by applyAnchorSessionTransition rather than applied — no
        // ownership check applies here since the anchor's shared-secret
        // signature (checked above) is the trust boundary for this route,
        // not a per-user JWT.
        await applyAnchorSessionTransition({
          sessionId,
          nextStatus,
          source: "webhook",
        });
      }
    }
    return reply.code(200).send({ ok: true });
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
