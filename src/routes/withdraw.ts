import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { anchorService } from "../services/anchor";
import { stellar } from "../services/stellar";
import { auditTx } from "../services/audit";
import { applyWithdrawalTransition } from "../services/withdrawal-status";
import { isPositive } from "../services/money";

const SUPPORTED_ASSET_CODES = ["USDC", "XLM"] as const;

const withdrawalBody = z.object({
  amount: z.string().min(1),
  assetCode: z.string().min(1),
  memo: z.string().max(28).optional(),
});

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

  app.post("/withdraw", { preHandler: [app.authenticate] }, async (req) => {
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
    { preHandler: [app.authenticate] },
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
          extraData: { anchorTxId: result.id } as never,
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
