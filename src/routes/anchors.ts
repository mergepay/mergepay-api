import { FastifyInstance, FastifyRequest } from "fastify";
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
import {
  accountPublicKeys,
  sep24CallbackAuditMetadata,
  sep24LifecycleAction,
  sep24StartAction,
} from "../services/sep24-audit";
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
import { getStatusHistory } from "../services/status-history";
import { validateAsset } from "../services/assets";
import {
  sep24CallbackQuerySchema,
  sep24CompleteRequestSchema,
  sep24DepositRequestSchema,
  sep24InitQuerySchema,
  sep24NoParamsSchema,
  sep24NoQuerySchema,
  sep24SessionParamsSchema,
  sep24SessionQuerySchema,
  sep24WithdrawRequestSchema,
} from "../validations/sep24";
import {
  sep24CallbackSchema,
  sep24DepositValidationMiddleware,
  sep24WithdrawValidationMiddleware,
  validateSep24DepositRequest,
  validateSep24WithdrawalRequest,
} from "../schemas/sep24";
import { openApiBody, openApiEnvelope, openApiIdParams } from "../lib/openapi";

export default async function anchorRoutes(app: FastifyInstance) {
  // Every anchor route that reaches an anchor gets an explicit budget so a
  // client cannot amplify one Mergepay request into unbounded upstream ones.
  // The global budget is 100 requests per window (`RATE_LIMIT_GLOBAL_MAX`).
  //
  //  - anchorInit  — 10/window (RATE_LIMIT_ANCHOR_INIT_MAX) for deposit/withdraw
  //    start and interactive completion. Each call fans out to stellar.toml +
  //    SEP-10 + SEP-24, so it is the tightest policy in the API.
  //  - anchorPoll  — 60/window (RATE_LIMIT_ANCHOR_POLL_MAX) for status reads.
  //    Cheaper, but still upstream-amplifying (or, for the DB-backed session
  //    list, the endpoint clients poll in a loop).
  //  - anchorWebhook — 50/window (RATE_LIMIT_ANCHOR_WEBHOOK_MAX) for the
  //    shared-secret callback, below the global budget but loose enough for
  //    anchor retries.
  //
  // Both authenticated policies are keyed by user, so one caller can never
  // exhaust another's budget. The webhook is keyed by IP because it is
  // authenticated by shared secret rather than a session.
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
    async (req) => {
      sep24NoParamsSchema.parse(req.params ?? {});
      sep24NoQuerySchema.parse(req.query ?? {});
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
  //
  // The `validateSep24Deposit` / `validateSep24Withdraw` preHandler hooks reject
  // malformed requests before any anchor I/O. The handler re-parses through the
  // same exported schema functions so it reads typed, normalised values without
  // introducing a second source of truth.
  async function start(kind: "deposit" | "withdrawal", req: FastifyRequest) {
    const auth = requireUser(req);

    const body =
      kind === "deposit"
        ? validateSep24DepositRequest(req.body)
        : validateSep24WithdrawalRequest(req.body);

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
        action: sep24StartAction(kind),
        entityType: "anchor_session",
        entityId: created.id,
        actorPublicKey: auth.stellarPublicKey,
        metadata: {
          kind,
          assetCode: body.assetCode,
          ...("amount" in body && body.amount ? { amount: body.amount } : {}),
        },
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
      preHandler: [app.authenticate, sep24DepositValidationMiddleware],
      ...initLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Initiate SEP-24 interactive deposit",
        description:
          "Initiates a SEP-24 interactive deposit session and returns an anchor auth challenge.",
        // Documented from the same Zod schema the preHandler parses with, but
        // with the rules stripped: the middleware is the only validator, so a
        // rejection arrives in the documented VALIDATION_ERROR envelope with
        // `issues`.
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
    async (req) => {
      sep24NoParamsSchema.parse(req.params ?? {});
      sep24InitQuerySchema.parse(req.query ?? {});
      return start("deposit", req);
    }
  );

  app.post(
    "/anchors/withdraw",
    {
      preHandler: [app.authenticate, sep24WithdrawValidationMiddleware],
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
    async (req) => {
      sep24NoParamsSchema.parse(req.params ?? {});
      sep24InitQuerySchema.parse(req.query ?? {});
      return start("withdrawal", req);
    }
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
          "Validates the session path, query, and signed SEP-10 challenge XDR with Zod, exchanges it for an anchor JWT, and returns the SEP-24 interactive URL.",
        params: openApiIdParams(),
        querystring: openApiBody(sep24SessionQuerySchema, { enforce: false }),
        // Documented from the same Zod schema the handler parses with, with the
        // rules stripped so the handler's parse is the only validator and a
        // rejection keeps the documented VALIDATION_ERROR envelope.
        body: openApiBody(sep24CompleteRequestSchema, { enforce: false }),
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["type", "url", "id", "session"],
            properties: {
              type: { type: "string", enum: ["interactive"] },
              url: { type: "string", format: "uri" },
              id: { type: "string" },
              session: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      // Query, path, then body: all Zod-owned, and all parsed before the
      // session is read or the anchor is contacted.
      sep24SessionQuerySchema.parse(req.query ?? {});
      const { id } = sep24SessionParamsSchema.parse(req.params);
      const body = sep24CompleteRequestSchema.parse(req.body);

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

      return {
        type: "interactive" as const,
        url: interactive.url,
        id: interactive.id,
        session: serializeAnchorSession(updated),
      };
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
      sep24NoParamsSchema.parse(req.params ?? {});
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
        description:
          "Validates the session path and query with Zod, then returns details and status for a specific SEP-24 anchor session.",
        params: openApiIdParams(),
        querystring: openApiBody(sep24SessionQuerySchema, { enforce: false }),
        response: openApiEnvelope("session"),
      },
    },
    async (req) => {
      const auth = requireUser(req);
      // Unknown query parameters are rejected rather than ignored, matching
      // every other SEP-24 status read in this API.
      sep24SessionQuerySchema.parse(req.query ?? {});
      const { id } = sep24SessionParamsSchema.parse(req.params);

      const session = await prisma.anchorSession.findUnique({
        where: { id },
      });
      if (!session || session.userId !== auth.id) {
        throw Errors.notFound("Anchor session not found");
      }

      // The timeline lives in `status_history`, keyed by (entityType, entityId)
      // rather than by a Prisma relation, so nothing reads it back on the
      // session query itself. Without this the route answered every poll with
      // an empty history, which is a claim about the transaction, not an
      // absence of data.
      const history = await getStatusHistory({
        entityType: "anchor_session",
        entityId: session.id,
      });

      return { session: serializeAnchorSession({ ...session, statusHistory: history }) };
    }
  );

  // -- webhook (signed) -------------------------------------------------------
  // Rate limiting here is abuse protection for an unauthenticated-until-
  // checked endpoint; it never substitutes for the shared-secret check
  // below, which remains the actual authentication/authorization gate.
  // `anchorWebhook` is 50 requests per window from
  // `RATE_LIMIT_ANCHOR_WEBHOOK_MAX`, below the global 100: enough headroom for
  // anchor retries without leaving this credential-gated ingress unlimited.
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

      sep24NoParamsSchema.parse(req.params ?? {});
      sep24CallbackQuerySchema.parse(req.query ?? {});
      const callback = sep24CallbackSchema.parse(req.body ?? {});
      const result = await applySep24Callback(callback);

      const withdrawal = await prisma.withdrawal.findUnique({
        where: { anchorTxId: callback.externalTransactionId },
      });
      if (withdrawal) {
        const publicKeys = await accountPublicKeys([withdrawal.userId]);
        await applyWithdrawalTransition({
          withdrawalId: withdrawal.id,
          nextStatus: mapAnchorStatusToWithdrawalStatus(
            mapAnchorStatus(callback.rawStatus)
          ),
          source: "webhook",
          auditAction: sep24LifecycleAction("withdrawal", callback.rawStatus),
          auditMetadata: sep24CallbackAuditMetadata(callback),
          actorPublicKey: publicKeys.get(withdrawal.userId),
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
