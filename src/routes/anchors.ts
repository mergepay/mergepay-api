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
import { applySep24Callback } from "../services/sep24";
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
import {
  sep24DepositRequestSchema,
  sep24InitQuerySchema,
  sep24WithdrawRequestSchema,
} from "../validations/sep24";
import { sep24CallbackSchema } from "../schemas/sep24";
import { openApiBody, openApiEnvelope, openApiIdParams } from "../lib/openapi";

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
    {
      preHandler: [app.authenticate],
      ...pollLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "List supported SEP-24 anchors",
        description: "Returns list of configured SEP-24 anchors and their supported assets.",
        response: openApiEnvelope("anchors"),
      },
    },
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
  async function start(
    kind: "deposit" | "withdrawal",
    req: any,
    requestSchema = kind === "deposit"
      ? sep24DepositRequestSchema
      : sep24WithdrawRequestSchema
  ) {
    const auth = requireUser(req);
    // Query first, then body: both are Zod-owned, and both run before the
    // anchor is contacted, so a malformed request never reaches an upstream
    // call, the database, or the audit log.
    sep24InitQuerySchema.parse(req.query ?? {});
    const body = requestSchema.parse(req.body);

    // Validate that the requested asset is supported. The issuer is part of
    // the request contract, so it is validated *with* the code rather than
    // dropped: a caller naming an issuer Mergepay does not issue that asset
    // under would otherwise get a session created against a different asset
    // than the one it asked for.
    validateAsset(body.assetCode, body.assetIssuer);

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

  app.post(
    "/anchors/deposit",
    {
      preHandler: [app.authenticate],
      ...initLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Initiate SEP-24 interactive deposit",
        description:
          "Initiates a SEP-24 interactive deposit session and returns an anchor auth challenge.",
        // Documented from the same Zod schema the handler parses with, but with
        // the rules stripped: the handler is the only validator, so a rejection
        // arrives in the documented VALIDATION_ERROR envelope with `issues`.
        querystring: openApiBody(sep24InitQuerySchema, { enforce: false }),
        body: openApiBody(sep24DepositRequestSchema, { enforce: false }),
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              session: { type: "object", additionalProperties: true },
              challenge: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    (req) => start("deposit", req)
  );

  app.post(
    "/anchors/withdraw",
    {
      preHandler: [app.authenticate],
      ...initLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Initiate SEP-24 interactive withdrawal",
        description:
          "Initiates a SEP-24 interactive withdrawal session and returns an anchor auth challenge.",
        querystring: openApiBody(sep24InitQuerySchema, { enforce: false }),
        body: openApiBody(sep24WithdrawRequestSchema, { enforce: false }),
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              session: { type: "object", additionalProperties: true },
              challenge: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    (req) => start("withdrawal", req)
  );

  // -- complete (exchange signed challenge for interactive url) ---------------
  app.post(
    "/anchors/sessions/:id/complete",
    {
      preHandler: [app.authenticate],
      ...initLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Complete SEP-24 interactive session",
        description:
          "Exchanges signed SEP-10 challenge for an anchor JWT and returns the SEP-24 interactive URL.",
        params: openApiIdParams(),
        body: openApiBody(z.object({ signedXdr: z.string().min(1) })),
        response: openApiEnvelope("session"),
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
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
  app.get(
    "/anchors/sessions",
    {
      preHandler: [app.authenticate],
      ...pollLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "List user anchor sessions",
        description:
          "Returns a paginated list of SEP-24 interactive sessions for the authenticated user.",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              sessions: { type: "array", items: { type: "object" } },
              meta: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (req) => {
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
    }
  );

  // -- get session ------------------------------------------------------------
  app.get(
    "/anchors/sessions/:id",
    {
      preHandler: [app.authenticate],
      ...pollLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Get anchor session status",
        description: "Returns details and status for a specific SEP-24 anchor session.",
        params: openApiIdParams(),
        response: openApiEnvelope("session"),
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);

      const session = await prisma.anchorSession.findUnique({
        where: { id },
      });
      if (!session || session.userId !== auth.id) {
        throw Errors.notFound("Anchor session not found");
      }

      return { session: serializeAnchorSession(session) };
    }
  );

  // -- webhook (signed) -------------------------------------------------------
  // Rate limiting here is abuse protection for an unauthenticated-until-
  // checked endpoint; it never substitutes for the shared-secret check
  // below, which remains the actual authentication/authorization gate.
  app.post(
    "/anchors/webhook",
    {
      ...rateLimited("anchorWebhook"),
      schema: {
        tags: ["SEP-24"],
        summary: "Anchor status webhook",
        description: "Receives signed webhook status notifications from SEP-24 anchors.",
        body: openApiBody(sep24CallbackSchema),
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              received: { type: "boolean" },
              status: { type: "string" },
              matched: { type: "integer" },
              updated: { type: "integer" },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const secret = (req.headers["x-anchor-signature"] ??
        req.headers["x-webhook-secret"]) as string | undefined;
      if (!secret || !constantTimeEqual(secret, config.ANCHOR_WEBHOOK_SECRET)) {
        return reply.code(200).send({ ok: true }); // don't reveal verification result
      }

      const callback = sep24CallbackSchema.parse(req.body ?? {});
      const result = await applySep24Callback(callback);

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { anchorTxId: callback.externalTransactionId },
      });
      if (withdrawal) {
        await applyWithdrawalTransition({
          withdrawalId: withdrawal.id,
          nextStatus: mapAnchorStatusToWithdrawalStatus(
            mapAnchorStatus(callback.rawStatus)
          ),
          source: "webhook",
        });
      }

      // 200 regardless of whether a session matched or the transition applied:
      // anchors retry non-2xx responses, and re-delivering a callback that was
      // correctly processed as a no-op only amplifies load.
      return reply.code(200).send({
        received: true,
        status: result.status,
        matched: result.matched,
        updated: result.updated,
      });
    }
  );
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
