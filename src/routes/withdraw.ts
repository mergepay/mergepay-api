import { FastifyInstance } from "fastify";
import { prisma } from "../db";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import {
  openApiBody,
  openApiEnvelope,
  openApiErrorResponses,
  openApiIdParams,
} from "../lib/openapi";
import { anchorService } from "../services/anchor";
import { stellar } from "../services/stellar";
import { auditTx } from "../services/audit";
import { applyWithdrawalTransition } from "../services/withdrawal-status";
import { isPositive } from "../services/money";
import { validateRequest } from "../middleware/validate-request";
import {
  sep24WithdrawalParamsSchema,
  sep24WithdrawalRequestBodySchema,
  type Sep24WithdrawalRequestBody,
} from "../validations/sep24";
import {
  signedXdrRequestSchema,
  type SignedXdrRequest,
} from "../validations/stellar-transaction";

const SUPPORTED_ASSET_CODES = ["USDC", "XLM"] as const;

// The request contracts these routes validate live in
// src/validations/sep24.ts (body, path id) and src/validations/stellar-transaction.ts
// (the signed envelope), shared with the other surfaces that take the same
// shapes. Each route parses them with a `validateRequest` preHandler (#923)
// registered after `app.authenticate`, so a malformed payload is a 400 before
// the handler touches the balance, the anchor, or the database — while an
// unauthenticated request is still a 401 rather than a 400. The handlers below
// read the parsed values back off the request. `src/validations/sep24.ts`
// explains why the withdrawal body validates *shape* at the boundary and
// leaves positivity and asset support to the handler.

function units(value: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  return (
    BigInt(whole) * 10000000n +
    BigInt((fraction + "0000000").slice(0, 7))
  );
}

function serializeWithdrawal(withdrawal: any) {
  return {
    id: withdrawal.id,
    userId: withdrawal.userId,
    amount: withdrawal.amount.toString(),
    assetCode: withdrawal.assetCode,
    memo: withdrawal.memo ?? null,
    anchorTxId: withdrawal.anchorTxId ?? null,
    interactiveUrl: withdrawal.interactiveUrl ?? null,
    status: withdrawal.status,
    failureReason: withdrawal.failureReason ?? null,
    createdAt: withdrawal.createdAt.toISOString(),
    updatedAt: withdrawal.updatedAt.toISOString(),
  };
}

export default async function withdrawalRoutes(app: FastifyInstance) {
  const withdrawalModel = (prisma as any).withdrawal;

  // On-chain payment submission surfaces (issues #363 / #403). Both draw on
  // dedicated per-route budgets rather than the 100/min global allowance:
  //
  //  - `POST /withdraw` initiates a withdrawal that fans out to the anchor's
  //    SEP-24 transfer server, so it shares the tight `anchorInit` budget
  //    (RATE_LIMIT_ANCHOR_INIT_MAX, default 10/min) used by the other anchor
  //    initiation routes — brute-forcing it must not exhaust a caller's
  //    global traffic.
  //  - `POST /withdraw/:id/confirm` exchanges a signed envelope for an anchor
  //    token and starts the interactive flow, so it shares the
  //    `settlementConfirm` budget (RATE_LIMIT_SETTLEMENT_CONFIRM_MAX, default
  //    20/min) with the other payment-confirmation routes, absorbing legitimate
  //    retries while bounding brute-force submission attempts.
  app.post(
    "/withdraw",
    {
      preHandler: [
        app.authenticate,
        validateRequest({ body: sep24WithdrawalRequestBodySchema }),
      ],
      ...rateLimited("anchorInit"),
      schema: {
        tags: ["SEP-24"],
        summary: "Start a SEP-24 withdrawal",
        description:
          "Validates the amount, asset code and optional memo with Zod, checks the caller's account for funding and a trustline, then returns the anchor's interactive withdrawal URL and a `pending` withdrawal record.",
        // Documented from the same Zod schema the preHandler parses with, but
        // with the rules stripped: the middleware is the validator, so a
        // rejection arrives in the documented VALIDATION_ERROR envelope with
        // `issues`.
        body: openApiBody(sep24WithdrawalRequestBodySchema, { enforce: false }),
        response: {
          ...openApiEnvelope("withdrawal"),
          ...openApiErrorResponses(400, 401, 429),
        },
      },
    },
    async (req) => {
    const auth = requireUser(req);
    // Parsed — and written back — by the validation preHandler above.
    const body = req.body as Sep24WithdrawalRequestBody;

    if (!isPositive(body.amount)) {
      throw Errors.badRequest(
        "invalid_amount",
        "Amount must be a positive decimal"
      );
    }
    if (!SUPPORTED_ASSET_CODES.includes(body.assetCode as any)) {
      throw Errors.badRequest(
        "unsupported_asset",
        `Unsupported asset code "${body.assetCode}"`
      );
    }

    const account = await stellar.loadAccount(auth.stellarPublicKey);
    if (!account.exists) {
      throw Errors.badRequest(
        "account_unfunded",
        "Your Stellar account is not funded yet."
      );
    }

    const balance = account.balances.find(
      (item) => item.assetCode === body.assetCode
    );
    if (!balance) {
      throw Errors.badRequest(
        "no_trustline",
        `Your account has no trustline for ${body.assetCode}`
      );
    }
    if (units(balance.balance) < units(body.amount)) {
      throw Errors.badRequest(
        "insufficient_balance",
        "Insufficient balance for this withdrawal."
      );
    }

    const anchor = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
    const interactiveUrl =
      `${anchor.transferServerSep24}/withdraw?asset_code=${encodeURIComponent(body.assetCode)}` +
      `&account=${encodeURIComponent(auth.stellarPublicKey)}` +
      `&amount=${encodeURIComponent(body.amount)}`;

    const withdrawal = await prisma.$transaction(async (tx) => {
      const created = await (tx as any).withdrawal.create({
        data: {
          userId: auth.id,
          amount: body.amount,
          assetCode: body.assetCode,
          memo: body.memo ?? null,
          interactiveUrl,
          status: "pending",
        },
      });
      await auditTx(tx, {
        userId: auth.id,
        action: "withdrawal.start",
        entityType: "withdrawal",
        entityId: created.id,
        metadata: { amount: body.amount, assetCode: body.assetCode },
      });
      return created;
    });

    return {
      withdrawal: serializeWithdrawal(withdrawal),
      interactive_url: interactiveUrl,
      transaction_id: withdrawal.id,
      status: withdrawal.status,
    };
  });

  app.post(
    "/withdraw/:id/confirm",
    {
      preHandler: [
        app.authenticate,
        validateRequest({
          params: sep24WithdrawalParamsSchema,
          body: signedXdrRequestSchema,
        }),
      ],
      ...rateLimited("settlementConfirm"),
      schema: {
        tags: ["SEP-24"],
        summary: "Confirm a withdrawal with a signed transaction",
        description:
          "Exchanges the caller's signed SEP-10 challenge XDR for an anchor token, starts the interactive withdrawal, and moves the record from `pending` to `processing`. The token is stored with the transition so the worker can keep polling the anchor if the callback never arrives. Repeating the call once the record has advanced is idempotent.",
        params: openApiIdParams(),
        // Unenforced, like the initiation body above: the validation preHandler
        // is the validator, and it is what names `signedXdr` in the response.
        body: openApiBody(signedXdrRequestSchema, { enforce: false }),
        response: {
          // Permissive, and not `openApiEnvelope("withdrawal")`: this step
          // answers with the withdrawal *flat* (`{ id, status, … }` plus
          // `transaction_id`), while initiation and the read route above and
          // below wrap the same record in a `withdrawal` key. Declaring the
          // envelope here would make Fastify's serializer reject a successful
          // confirmation, and re-shaping the body is a client-visible contract
          // change that is not this route's to make.
          200: { type: "object", additionalProperties: true },
          ...openApiErrorResponses(400, 401, 404, 429),
        },
      },
    },
    async (req) => {
      const auth = requireUser(req);
      // Path and body are parsed by the validation preHandler above.
      const { id } = req.params as { id: string };
      // The shared signed-XDR contract (issue #419): canonical base64 that the
      // SDK can decode as a transaction envelope, enforced by that preHandler.
      // Before that contract, any non-empty string was forwarded to the
      // anchor's `GET /challenge` endpoint and failed there as an upstream
      // error — a 502 for what is a bad request.
      const { signedXdr } = req.body as SignedXdrRequest;
      const withdrawal = await withdrawalModel.findUnique({ where: { id } });

      if (!withdrawal || withdrawal.userId !== auth.id) {
        throw Errors.notFound("Withdrawal not found");
      }
      // Fast path only — avoids a wasted round trip to the anchor for the
      // common case of a retried confirm call. The actual correctness
      // guarantee against a concurrent duplicate is the guarded update
      // inside applyWithdrawalTransition below.
      if (withdrawal.status !== "pending") {
        return serializeWithdrawal(withdrawal);
      }

      try {
        const anchor = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
        const token = await anchorService.getToken(
          anchor.webAuthEndpoint,
          signedXdr
        );
        const result = await anchorService.startInteractive({
          transferServer: anchor.transferServerSep24,
          token,
          kind: "withdrawal",
          assetCode: withdrawal.assetCode,
          account: auth.stellarPublicKey,
        });
        const { withdrawal: updated } = await applyWithdrawalTransition({
          withdrawalId: id,
          nextStatus: "processing",
          source: "user",
          ownerUserId: auth.id,
          // The JWT is stored atomically with the transition so the worker
          // can poll the anchor for this withdrawal's status later — the
          // server cannot mint one itself (the SEP-10 challenge must be
          // signed by the user's key), and without it a lost webhook would
          // leave the withdrawal stuck in `processing` forever.
          extraData: { anchorTxId: result.id, anchorToken: token },
        });
        return {
          ...serializeWithdrawal(updated),
          interactive_url: result.url,
          transaction_id: result.id,
        };
      } catch (error) {
        await applyWithdrawalTransition({
          withdrawalId: id,
          nextStatus: "failed",
          source: "user",
          ownerUserId: auth.id,
        });
        if (error instanceof AppError) throw error;
        throw Errors.upstream("Withdrawal confirmation failed");
      }
    }
  );

  app.get(
    "/withdraw/:id",
    {
      // The anchor-transaction status read a client polls while an
      // interactive withdrawal runs, so it takes the same budget as the other
      // anchor polls (#693) rather than the global one it shares with every
      // unrelated read.
      ...rateLimited("anchorPoll"),
      preHandler: [
        app.authenticate,
        validateRequest({ params: sep24WithdrawalParamsSchema }),
      ],
      schema: {
        tags: ["SEP-24"],
        summary: "Read a withdrawal",
        description:
          "Returns one withdrawal owned by the caller, including the anchor transaction id once the interactive flow has started.",
        params: openApiIdParams(),
        response: {
          ...openApiEnvelope("withdrawal"),
          ...openApiErrorResponses(401, 403, 404),
        },
      },
    },
    async (req) => {
    const auth = requireUser(req);
    // Parsed by the validation preHandler above.
    const { id } = req.params as { id: string };
    const withdrawal = await withdrawalModel.findUnique({ where: { id } });
    if (!withdrawal) {
      throw Errors.notFound("Withdrawal not found");
    }
    if (withdrawal.userId !== auth.id) {
      throw Errors.forbidden("You do not own this withdrawal");
    }

    return {
      withdrawal: serializeWithdrawal(withdrawal),
      transaction_id: withdrawal.anchorTxId,
      status: withdrawal.status,
    };
  });
}
