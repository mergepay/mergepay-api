/**
 * SEP-24 anchor callback endpoint.
 *
 * Registered outside the authenticated route scopes: an anchor has no Mergepay
 * session and never will. Its credential is the JWT it signs with its SEP-10
 * key, verified in src/services/sep24-anchor-token.ts against the key
 * published in that anchor's own stellar.toml.
 *
 * This is not the only SEP-24 callback surface. `POST /api/webhooks/sep24`
 * (src/routes/webhooks.ts) accepts the same events from anchors that
 * authenticate with a pre-shared HMAC secret rather than a SEP-10 JWT. The
 * two exist side by side because anchors differ in which scheme they support;
 * each verifies its own credential and both converge on session state.
 */
import type { FastifyInstance } from "fastify";
import { config } from "../config";
import { prisma } from "../db";
import { requireUser } from "../plugins/auth";
import { anchorService } from "../services/anchor";
import { auditTx } from "../services/audit";
import { serializeAnchorSession } from "../serializers";
import { validateAsset } from "../services/assets";
import { rateLimited } from "../lib/rate-limit";
import { openApiBody } from "../lib/openapi";
import {
  applySep24Callback,
  sep24CallbackSchema,
  verifyAnchorToken,
} from "../services/sep24-anchor-token";
import {
  sep24CallbackQuerySchema,
  sep24DepositRequestSchema,
  sep24InitQuerySchema,
  sep24WithdrawRequestSchema,
} from "../validations/sep24";
import {
  validateSep24Deposit,
  validateSep24Withdraw,
} from "../schemas/sep24";

export default async function sep24Routes(app: FastifyInstance) {
  const initLimit = rateLimited("anchorInit");

  async function handleStartInteractive(
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

    // The issuer is part of the request contract, so it is validated *with*
    // the code rather than dropped: a caller naming an issuer Mergepay does not
    // issue that asset under would otherwise get a session created against a
    // different asset than the one it asked for.
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
    "/api/sep24/deposit",
    {
      preHandler: [app.authenticate, validateSep24Deposit],
      ...initLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Initiate SEP-24 deposit flow with Zod validation",
        description:
          "Validates payload with Zod and initiates a SEP-24 deposit interactive session.",
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
    (req) => handleStartInteractive("deposit", req)
  );

  app.post(
    "/api/sep24/withdraw",
    {
      preHandler: [app.authenticate, validateSep24Withdraw],
      ...initLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Initiate SEP-24 withdrawal flow with Zod validation",
        description:
          "Validates payload with Zod and initiates a SEP-24 withdrawal interactive session.",
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
    (req) => handleStartInteractive("withdrawal", req)
  );
  // Rate limiting here is abuse protection for an endpoint that is
  // unauthenticated until the token is checked. It never substitutes for that
  // check, which remains the authorization gate. Keyed by IP because there is
  // no authenticated user to key by.
  app.post(
    "/api/sep24/callback",
    {
      ...rateLimited("sep24Callback"),
      schema: {
        tags: ["SEP-24"],
        summary: "Process SEP-24 anchor callback",
        description:
          "Accepts and processes SEP-24 transaction status callbacks signed with the anchor SEP-10 JWT token.",
        querystring: openApiBody(sep24CallbackQuerySchema),
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
      // Verified before the body is parsed, so an unauthenticated caller never
      // reaches the schema, the database, or the audit log.
      await verifyAnchorToken(req.headers.authorization);

      sep24CallbackQuerySchema.parse(req.query ?? {});

      const callback = sep24CallbackSchema.parse(req.body ?? {});
      const result = await applySep24Callback(callback);

      // 200 even when no session matched or the transition was disallowed.
      // Anchors retry non-2xx responses, so returning an error for a callback
      // that was correctly processed as a no-op only amplifies load.
      return reply.code(200).send({
        received: true,
        status: result.status,
        matched: result.matched,
        updated: result.updated,
      });
    }
  );
}
