import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { stellar, memoText } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit, AuditAction } from "../services/audit";
import { normalizeAmount } from "../services/money";
import { serializeGroup, serializeTreasuryTx } from "../serializers";
import {
  stellarPublicKeySchema,
  stellarAmountSchema,
  refineStellarAsset,
} from "../lib/stellar-validation";

export default async function treasuryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- enable -----------------------------------------------------------------
  app.post("/groups/:id/treasury/enable", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    const body = z
      .object({
        publicKey: stellarPublicKeySchema,
        requiredSigners: z.number().int().min(1).max(20).optional(),
      })
      .parse(req.body);

    // Confirm the account exists on-chain (skipped in test mode via mock).
    if (!config.isTest) {
      const snapshot = await stellar.loadAccount(body.publicKey);
      if (!snapshot.exists) {
        throw Errors.badRequest(
          "account_unfunded",
          "Create and fund the treasury account before enabling it"
        );
      }
    }

    const group = await prisma.$transaction(async (tx) => {
      const updated = await tx.group.update({
        where: { id },
        data: {
          treasuryEnabled: true,
          treasuryAccountPublicKey: body.publicKey,
          treasuryRequiredSigners: body.requiredSigners ?? 1,
        },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.TreasuryEnable,
          entityType: "group",
          entityId: id,
          metadata: { publicKey: body.publicKey, requiredSigners: body.requiredSigners ?? 1 },
        },
        tx
      );
      return updated;
    });
    return { group: serializeGroup(group) };
  });

  // -- info -------------------------------------------------------------------
  app.get("/groups/:id/treasury", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const snapshot = await stellar.loadAccount(group.treasuryAccountPublicKey);
    return {
      publicKey: group.treasuryAccountPublicKey,
      balances: snapshot.balances.map((b) => ({
        assetCode: b.assetCode,
        assetIssuer: b.assetIssuer,
        balance: b.balance,
      })),
      signers: snapshot.signers,
      thresholds: snapshot.thresholds,
    };
  });

  // -- deposit ----------------------------------------------------------------
  app.post("/groups/:id/treasury/deposit", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const body = z
      .object({
        amount: stellarAmountSchema,
        assetCode: z.string().min(1).max(12),
        assetIssuer: z.string().nullable().optional(),
      })
      .superRefine((val, ctx) => refineStellarAsset(ctx, val.assetCode, val.assetIssuer))
      .parse(req.body);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const amount = normalizeAmount(body.amount);
    const code = shortCode();
    const ttx = await prisma.$transaction(async (tx) => {
      const created = await tx.treasuryTransaction.create({
        data: {
          shortCode: code,
          groupId: id,
          userId: auth.id,
          direction: "deposit",
          amount,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          destination: group.treasuryAccountPublicKey,
          status: "pending",
          memo: memoText(code),
        },
        include: { user: true },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.TreasuryDepositCreate,
          entityType: "treasury_transaction",
          entityId: created.id,
          metadata: { groupId: id, amount, assetCode: body.assetCode },
        },
        tx
      );
      return created;
    });

    const account = await stellar.loadAccount(auth.stellarPublicKey);
    if (!account.exists) {
      throw Errors.badRequest("account_unfunded", "Your account is not funded yet");
    }
    const xdr = stellar.buildPayment({
      sourcePublicKey: auth.stellarPublicKey,
      sourceSequence: account.sequence,
      destination: group.treasuryAccountPublicKey,
      asset: { code: body.assetCode, issuer: body.assetIssuer ?? null },
      amount,
      memoCode: code,
    });

    return {
      treasuryTransaction: serializeTreasuryTx(ttx),
      xdr,
      networkPassphrase: config.networkPassphrase,
    };
  });

  // -- withdraw ---------------------------------------------------------------
  app.post("/groups/:id/treasury/withdraw", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    const body = z
      .object({
        amount: stellarAmountSchema,
        assetCode: z.string().min(1).max(12),
        assetIssuer: z.string().nullable().optional(),
        destination: stellarPublicKeySchema,
      })
      .superRefine((val, ctx) => refineStellarAsset(ctx, val.assetCode, val.assetIssuer))
      .parse(req.body);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const amount = normalizeAmount(body.amount);
    const requiresMulti = (group.treasuryRequiredSigners ?? 1) > 1;
    const code = shortCode();
    const ttx = await prisma.$transaction(async (tx) => {
      const created = await tx.treasuryTransaction.create({
        data: {
          shortCode: code,
          groupId: id,
          userId: auth.id,
          direction: "withdrawal",
          amount,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          destination: body.destination,
          status: requiresMulti ? "awaiting_signatures" : "pending",
          memo: memoText(code),
        },
        include: { user: true },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.TreasuryWithdrawCreate,
          entityType: "treasury_transaction",
          entityId: created.id,
          metadata: {
            groupId: id,
            amount,
            assetCode: body.assetCode,
            destination: body.destination,
          },
        },
        tx
      );
      return created;
    });

    const account = await stellar.loadAccount(group.treasuryAccountPublicKey);
    if (!account.exists) {
      throw Errors.badRequest("treasury_unfunded", "Treasury account is not funded");
    }
    const xdr = stellar.buildPayment({
      sourcePublicKey: group.treasuryAccountPublicKey,
      sourceSequence: account.sequence,
      destination: body.destination,
      asset: { code: body.assetCode, issuer: body.assetIssuer ?? null },
      amount,
      memoCode: code,
    });

    return {
      treasuryTransaction: serializeTreasuryTx(ttx),
      xdr,
      networkPassphrase: config.networkPassphrase,
    };
  });

  // -- confirm treasury tx ----------------------------------------------------
  app.post("/treasury-transactions/:id/confirm", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);

    const ttx = await prisma.treasuryTransaction.findUnique({ where: { id } });
    if (!ttx) throw Errors.notFound("Treasury transaction not found");

    const group = await prisma.group.findUnique({ where: { id: ttx.groupId } });
    if (!group?.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    if (ttx.direction === "deposit") {
      if (ttx.userId !== auth.id) {
        throw Errors.forbidden("Only the depositor can confirm this deposit");
      }
    } else {
      await requireAdmin(ttx.groupId, auth.id);
    }
    if (ttx.status === "confirmed") {
      return { treasuryTransaction: serializeTreasuryTx(ttx) };
    }

    const source =
      ttx.direction === "deposit"
        ? auth.stellarPublicKey
        : group.treasuryAccountPublicKey;
    const destination =
      ttx.direction === "deposit"
        ? group.treasuryAccountPublicKey
        : ttx.destination!;

    let hash: string;
    try {
      hash = await stellar.submitPayment(body.signedXdr, {
        sourcePublicKey: source,
        destination,
        asset: { code: ttx.assetCode, issuer: ttx.assetIssuer },
        amount: ttx.amount.toString(),
        memoCode: ttx.shortCode,
      });
    } catch (e: any) {
      await prisma.$transaction(async (tx) => {
        await tx.treasuryTransaction.update({
          where: { id },
          data: { status: "failed" },
        });
        await audit(
          {
            actor: { type: "user", userId: auth.id },
            action: AuditAction.TreasuryConfirmFailed,
            entityType: "treasury_transaction",
            entityId: id,
            outcome: "failure",
            metadata: { direction: ttx.direction, reason: e?.message ?? String(e) },
          },
          tx
        );
      });
      throw e;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const saved = await tx.treasuryTransaction.update({
        where: { id },
        data: { status: "confirmed", stellarTxHash: hash },
        include: { user: true },
      });
      await audit(
        {
          actor: { type: "user", userId: auth.id },
          action: AuditAction.TreasuryConfirm,
          entityType: "treasury_transaction",
          entityId: id,
          metadata: { hash, direction: ttx.direction },
        },
        tx
      );
      return saved;
    });
    return { treasuryTransaction: serializeTreasuryTx(updated) };
  });

  // -- history ----------------------------------------------------------------
  app.get("/groups/:id/treasury/history", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const transactions = await prisma.treasuryTransaction.findMany({
      where: { groupId: id },
      include: { user: true },
      orderBy: { createdAt: "desc" },
    });
    return { transactions: transactions.map(serializeTreasuryTx) };
  });
}
