import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { anchorService } from "../services/anchor";
import { stellar } from "../services/stellar";
import { audit } from "../services/audit";

const amountSchema = z
  .string()
  .regex(/^\d+(?:\.\d{1,7})?$/, "Amount must be a positive decimal")
  .refine(
    (value) => {
      const [whole, fraction = ""] = value.split(".");
      return (
        BigInt(whole) * 10000000n +
          BigInt((fraction + "0000000").slice(0, 7)) >
        0n
      );
    },
    { message: "Amount must be greater than zero" }
  );

const withdrawalBody = z.object({
  amount: amountSchema,
  asset_code: z.enum(["USDC", "XLM"]),
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
    status: withdrawal.status,
    createdAt: withdrawal.createdAt.toISOString(),
    updatedAt: withdrawal.updatedAt.toISOString(),
  };
}

export default async function withdrawalRoutes(app: FastifyInstance) {
  const withdrawalModel = (prisma as any).withdrawal;

  app.post("/withdraw", { preHandler: [app.authenticate] }, async (req) => {
    const auth = requireUser(req);
    const body = withdrawalBody.parse(req.body);
    const account = await stellar.loadAccount(auth.stellarPublicKey);

    if (!account.exists) {
      throw Errors.badRequest(
        "account_unfunded",
        "Your Stellar account is not funded yet."
      );
    }

    const balance = account.balances.find(
      (item) => item.assetCode === body.asset_code
    );
    if (!balance || units(balance.balance) < units(body.amount)) {
      throw Errors.badRequest(
        "insufficient_balance",
        "Insufficient balance for this withdrawal."
      );
    }

    const withdrawal = await withdrawalModel.create({
      data: {
        userId: auth.id,
        amount: body.amount,
        assetCode: body.asset_code,
        memo: body.memo ?? null,
        status: "pending",
      },
    });

    await audit({
      userId: auth.id,
      action: "withdrawal.start",
      entityType: "withdrawal",
      entityId: withdrawal.id,
      metadata: { amount: body.amount, assetCode: body.asset_code },
    });

    const anchor = await anchorService.getToml(config.ANCHOR_HOME_DOMAIN);
    const challenge = await anchorService.getChallenge(
      anchor.webAuthEndpoint,
      auth.stellarPublicKey
    );

    return {
      ...serializeWithdrawal(withdrawal),
      interactive_url: null,
      transaction_id: null,
      challenge,
      networkPassphrase: challenge.networkPassphrase || config.networkPassphrase,
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
        const updated = await withdrawalModel.update({
          where: { id },
          data: { anchorTxId: result.id, status: "pending" },
        });
        return {
          ...serializeWithdrawal(updated),
          interactive_url: result.url,
          transaction_id: result.id,
        };
      } catch (error) {
        await withdrawalModel.update({
          where: { id },
          data: { status: "failed" },
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
    if (!withdrawal || withdrawal.userId !== auth.id) {
      throw Errors.notFound("Withdrawal not found");
    }

    return {
      ...serializeWithdrawal(withdrawal),
      transaction_id: withdrawal.anchorTxId,
      status: withdrawal.status,
    };
  });
}
