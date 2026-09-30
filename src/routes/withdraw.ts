import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { mpMemoSchema } from "../lib/stellar-validation";
import { assetCodeSchema } from "../schemas/asset";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { rateLimited } from "../lib/rate-limit";
import { anchorService } from "../services/anchor";
import { stellar } from "../services/stellar";
import { auditTx } from "../services/audit";
import { applyWithdrawalTransition } from "../services/withdrawal-status";
import { isPositive } from "../services/money";
import {
  sep24AmountShapeSchema,
  sep24AssetCodeShapeSchema,
} from "../validations/sep24";

const SUPPORTED_ASSET_CODES = ["USDC", "XLM"] as const;

/**
 * `POST /withdraw` is a concrete SEP-24 withdrawal request, so its body is
 * validated with the shared SEP-24 shape rules from src/validations/sep24.ts
 * — decimal amount with at most 7 fractional digits, alphanumeric asset code —
 * and the object is strict: an unexpected field is a structured 400 instead
 * of being silently stripped.
 *
 * Positivity and asset *support* stay in the handler below: they carry their
 * own established error codes (`INVALID_AMOUNT`, `UNSUPPORTED_ASSET`) that a
 * schema-level failure would otherwise swallow.
 */
const withdrawalBody = z
  .object({
    amount: sep24AmountShapeSchema,
    assetCode: sep24AssetCodeShapeSchema,
    memo: mpMemoSchema.optional(),
  })
  .strict();

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
  //  - `POST /withdraw/:id/confirm` submits a signed XDR to the network and
  //    shares the `settlementConfirm` budget
  //    (RATE_LIMIT_SETTLEMENT_CONFIRM_MAX, default 20/min) with the other
  //    payment-confirmation routes, absorbing legitimate retries while
  //    bounding brute-force submission attempts.
  app.post(
    "/withdraw",
    { preHandler: [app.authenticate], ...rateLimited("anchorInit") },
    async (req) => {
    const auth = requireUser(req);
    const body = withdrawalBody.parse(req.body);

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
    { preHandler: [app.authenticate], ...rateLimited("settlementConfirm") },
    async (req) => {
      const auth = requireUser(req);
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);
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
          body.signedXdr
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

  app.get("/withdraw/:id", { preHandler: [app.authenticate] }, async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
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
