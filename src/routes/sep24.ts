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
import type { FastifyInstance, FastifyRequest } from "fastify";
import { config } from "../config";
import { prisma } from "../db";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { anchorService } from "../services/anchor";
import { auditTx } from "../services/audit";
import { serializeAnchorSession } from "../serializers";
import { validateAsset } from "../services/assets";
import { getStatusHistory } from "../services/status-history";
import { toSep24TransactionView } from "../services/sep24-status";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  requireCursor,
  takeForPage,
} from "../lib/pagination";
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
  sep24TransactionQuerySchema,
  sep24TransactionsQuerySchema,
  sep24WithdrawRequestSchema,
} from "../validations/sep24";
import {
  validateSep24Deposit,
  validateSep24Withdraw,
} from "../schemas/sep24";

/**
 * The JSON schema of one SEP-24 transaction object, as rendered by
 * `toSep24TransactionView`.
 *
 * Declared once because two routes answer with it: the single-transaction poll
 * and the list poll return the *same* shape, and a field added to the view
 * without being declared here is silently dropped by the serializer. Locking
 * `additionalProperties` makes that a visible contract change rather than a
 * response that quietly loses a field on one route and not the other.
 */
const sep24TransactionResponse: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "status", "session_id", "started_at", "status_history"],
  properties: {
    id: { type: "string" },
    kind: { type: "string", enum: ["deposit", "withdrawal"] },
    status: { type: "string" },
    session_id: { type: "string" },
    more_info_url: { type: "string" },
    started_at: { type: "string" },
    updated_at: { type: "string" },
    completed_at: { type: "string" },
    message: { type: "string" },
    status_history: {
      type: "array",
      items: {
        type: "object",
        required: ["status", "at", "source", "reason"],
        additionalProperties: false,
        properties: {
          status: { type: "string" },
          at: { type: "string" },
          source: { type: ["string", "null"] },
          reason: { type: ["string", "null"] },
        },
      },
    },
  },
};

/**
 * Read one page of the caller's sessions and render each as a SEP-24
 * transaction object.
 *
 * Shared by both status-poll routes so the list cannot answer a transaction
 * differently from the single-transaction route it is meant to feed. Each row's
 * timeline is read per session, concurrently, the same way `GET /groups`
 * enriches its page — the bound that matters is the page itself (`limit` ≤ 100),
 * and `getStatusHistory` caps each timeline at 50 rows newest-first.
 */
async function toSep24TransactionViews(sessions: readonly Sep24SessionRow[]) {
  return Promise.all(
    sessions.map(async (session) =>
      toSep24TransactionView(
        session,
        await getStatusHistory({
          entityType: "anchor_session",
          entityId: session.id,
        })
      )
    )
  );
}

/** The session columns the status view reads. Structural, so Prisma rows fit. */
interface Sep24SessionRow {
  id: string;
  kind: string;
  status: string;
  externalTransactionId: string | null;
  interactiveUrl: string | null;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export default async function sep24Routes(app: FastifyInstance) {
  const initLimit = rateLimited("anchorInit");
  const pollLimit = rateLimited("anchorPoll");

  async function handleStartInteractive(
    kind: "deposit" | "withdrawal",
    req: FastifyRequest,
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
    "/sep24/deposit",
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
    "/sep24/withdraw",
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

  // SEP-24 status polling (#651).
  //
  // The session row is the source of truth, and it is kept current by the
  // worker's anchor polling (src/worker/index.ts). Answering from the database
  // rather than by calling the anchor here is deliberate: a client polling this
  // route in a loop must not be able to amplify one request per user into one
  // request per poll against the anchor, which is the failure mode the
  // `anchorInit` budget exists to prevent.
  //
  // The response is the SEP-24 transaction object itself, not Mergepay's
  // session envelope, because this is the endpoint a SEP-24-aware client
  // expects. Fields the spec marks optional and Mergepay does not track
  // (`status_eta`, `amount_in`, `fee_details`, …) are omitted rather than
  // invented; `session_id` and `status_history` are Mergepay's own additions.
  app.get(
    "/sep24/transaction",
    {
      preHandler: [app.authenticate],
      ...pollLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "Poll SEP-24 transaction status",
        description:
          "Returns the SEP-24 transaction object for one deposit or withdrawal, including Mergepay's status timeline.",
        // Documented but not compiler-enforced: the handler is the only
        // validator, so a rejection arrives in the VALIDATION_ERROR envelope
        // with `issues` naming the field.
        querystring: openApiBody(sep24TransactionQuerySchema, { enforce: false }),
        response: {
          200: sep24TransactionResponse,
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { id } = sep24TransactionQuerySchema.parse(req.query ?? {});

      // Scoped to the caller, so another user's transaction is a 404 rather
      // than a 403: a status poll must not confirm that an id exists
      // somewhere else in the system.
      const session = await prisma.anchorSession.findFirst({
        where: { userId: auth.id, OR: [{ id }, { externalTransactionId: id }] },
      });
      if (!session) throw Errors.notFound("Transaction not found");

      const history = await getStatusHistory({
        entityType: "anchor_session",
        entityId: session.id,
      });

      return toSep24TransactionView(session, history);
    }
  );

  // SEP-24 transaction list polling (#655).
  //
  // `GET /transaction` answers for one transaction; a wallet that has just
  // reopened needs the caller's whole set to know which of them to poll, and
  // without a list the only options are the Mergepay-shaped
  // `GET /anchors/sessions` — which returns sessions, not the SEP-24
  // transaction object the spec defines — or replaying one id per request.
  // This route returns the same transaction object as the single poll, in the
  // spec's `{ transactions: […] }` envelope, over the API's shared cursor
  // pagination.
  //
  // Reads come from the database only, for the reason the single poll documents
  // above: a client paging through a loop must not be able to amplify its own
  // polling into anchor traffic.
  app.get(
    "/sep24/transactions",
    {
      preHandler: [app.authenticate],
      ...pollLimit,
      schema: {
        tags: ["SEP-24"],
        summary: "List SEP-24 transactions for status polling",
        description:
          "Returns the caller's SEP-24 transaction objects, newest first, optionally filtered by transfer direction. " +
          "Accepts the shared pagination parameters — `limit` (1-100, default 50), `cursor`, `order` (asc|desc) — plus SEP-24's `kind` (deposit|withdrawal) and `lang`. Keyset-paginated.",
        // No `querystring` schema, unlike this file's other routes: ajv runs
        // with coercion off (src/app.ts), so a documented `limit` of
        // `type: "integer"` would judge the string `"2"` a query string
        // actually carries and 400 a valid page request. Every paginated list
        // in this API — /groups, /anchors/sessions, /history — documents its
        // parameters in the description and lets Zod own the validation;
        // this one cannot do otherwise.
        response: {
          200: {
            type: "object",
            additionalProperties: false,
            required: ["transactions", "meta"],
            properties: {
              transactions: {
                type: "array",
                items: sep24TransactionResponse,
              },
              meta: {
                type: "object",
                required: ["nextCursor", "hasMore", "limit", "order"],
                additionalProperties: false,
                properties: {
                  nextCursor: { type: ["string", "null"] },
                  hasMore: { type: "boolean" },
                  limit: { type: "integer" },
                  order: { type: "string", enum: ["asc", "desc"] },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      const { cursor, limit, order, kind } = sep24TransactionsQuerySchema.parse(
        req.query ?? {}
      );
      const position = requireCursor(cursor);

      // The `kind` filter is the view's normalisation written as a query, not
      // the stored column read literally: `toSep24Kind` treats anything other
      // than "withdrawal" as a deposit, so asking for deposits has to match
      // every row that is not a withdrawal. Filtering `kind = 'deposit'`
      // instead would let a row the view renders as a deposit disappear from the
      // filtered list — a transaction that vanishes between the two routes is
      // worse than a corrupt value is worth.
      const sessions = await prisma.anchorSession.findMany({
        where: {
          userId: auth.id,
          ...(kind === undefined
            ? {}
            : kind === "withdrawal"
              ? { kind: "withdrawal" }
              : { kind: { not: "withdrawal" } }),
          ...cursorFilter(position, order),
        },
        orderBy: cursorOrderBy(order),
        take: takeForPage(limit),
      });

      const { items, meta } = buildPage(sessions, limit, order);
      const transactions = await toSep24TransactionViews(items);

      return { transactions, meta };
    }
  );
  // Rate limiting here is abuse protection for an endpoint that is
  // unauthenticated until the token is checked. It never substitutes for that
  // check, which remains the authorization gate. Keyed by IP because there is
  // no authenticated user to key by.
  app.post(
    "/sep24/callback",
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
