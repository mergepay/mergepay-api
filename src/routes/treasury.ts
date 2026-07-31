import { FastifyInstance } from "fastify";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { stellar, memoText } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit } from "../services/audit";
import { validateAsset, validateAmount } from "../services/assets";
import { rateLimited } from "../lib/rate-limit";
import {
  assertIntentNotExpired,
  intentExpiry,
  intentValiditySchema,
  secondsUntilExpiry,
} from "../lib/time-bounds";
import { serializeGroup, serializeTreasuryTx } from "../serializers";
import { paginationQuerySchema, encodeCursor, decodeCursor } from "../lib/pagination";
import { validateAmount, validateAsset } from "../services/assets";
import {
  validateProposedSignerConfig,
  validateSignerChangeAgainstAccount,
  snapshotToSignerConfig,
  type ProposedSignerConfig,
} from "../services/treasury-validation";

export default async function treasuryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- enable -----------------------------------------------------------------
  app.post("/groups/:id/treasury/enable", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    const body = z
      .object({
        publicKey: z.string(),
        requiredSigners: z.number().int().min(1).max(20).optional(),
      })
      .parse(req.body);

    if (!StrKey.isValidEd25519PublicKey(body.publicKey)) {
      throw Errors.badRequest("invalid_public_key", "Not a valid Stellar public key");
    }

    if (!config.isTest) {
      const snapshot = await stellar.loadAccount(body.publicKey);
      if (!snapshot.exists) {
        throw Errors.badRequest(
          "account_unfunded",
          "Create and fund the treasury account before enabling it"
        );
      }
    }

    const group = await prisma.group.update({
      where: { id },
      data: {
        treasuryEnabled: true,
        treasuryAccountPublicKey: body.publicKey,
        treasuryRequiredSigners: body.requiredSigners ?? 1,
      },
    });
    await audit({
      userId: auth.id,
      action: "treasury.enable",
      entityType: "group",
      entityId: id,
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

  // -- validate signer config -------------------------------------------------
  app.post("/groups/:id/treasury/validate-signers", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    
    const body = z
      .object({
        signers: z.array(
          z.object({
            publicKey: z.string(),
            weight: z.number().int().min(0).max(255),
          })
        ),
        thresholds: z.object({
          low: z.number().int().min(0).max(255),
          med: z.number().int().min(0).max(255),
          high: z.number().int().min(0).max(255),
        }),
      })
      .parse(req.body);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const snapshot = await stellar.loadAccount(group.treasuryAccountPublicKey);
    
    const proposedConfig: ProposedSignerConfig = {
      signers: body.signers,
      thresholds: body.thresholds,
    };

    const validation = validateProposedSignerConfig(proposedConfig, snapshot);
    
    await audit({
      userId: auth.id,
      action: "treasury.signer_validation",
      entityType: "group",
      entityId: id,
      metadata: {
        valid: validation.valid,
        errors: validation.errors,
      },
    });

    return {
      valid: validation.valid,
      errors: validation.errors,
    };
  });

  // -- deposit ----------------------------------------------------------------
  app.post("/groups/:id/treasury/deposit", rateLimited("settlementCreate"), async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const body = z
      .object({
        amount: z.string().min(1),
        assetCode: z.string().min(1),
        assetIssuer: z.string().nullable().optional(),
        // A client may ask for a shorter signing window; the server clock still
        // decides the deadline.
        validitySeconds: intentValiditySchema.optional(),
      })
      .parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    validateAmount(body.amount);
    validateAsset(body.assetCode, body.assetIssuer ?? null);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const treasuryKey = group.treasuryAccountPublicKey!;
    return runIdempotent({
      userId: auth.id,
      scope: "treasury.deposit",
      key: idempotencyKey,
      resourceId: id,
      payload: body,
      operation: async () => {
        const code = shortCode();
        const ttx = await prisma.treasuryTransaction.create({
          data: {
            shortCode: code,
            groupId: id,
            userId: auth.id,
            direction: "deposit",
            amount: body.amount,
            assetCode: body.assetCode,
            assetIssuer: body.assetIssuer ?? null,
            destination: treasuryKey,
            status: "pending",
            memo: memoText(code),
          },
          include: { user: true },
        });

        const account = await stellar.loadAccount(auth.stellarPublicKey);
        if (!account.exists) {
          throw Errors.badRequest("account_unfunded", "Your account is not funded yet");
        }
        const xdr = stellar.buildPayment({
          sourcePublicKey: auth.stellarPublicKey,
          sourceSequence: account.sequence,
          destination: treasuryKey,
          asset: { code: body.assetCode, issuer: body.assetIssuer ?? null },
          amount: body.amount,
          memoCode: code,
        });

        return {
          treasuryTransaction: serializeTreasuryTx(ttx),
          xdr,
          networkPassphrase: config.networkPassphrase,
        };
      },
    });
  });

  // -- withdraw ---------------------------------------------------------------
  app.post("/groups/:id/treasury/withdraw", rateLimited("settlementCreate"), async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    const body = z
      .object({
        amount: z.string().min(1),
        assetCode: z.string().min(1),
        assetIssuer: z.string().nullable().optional(),
        destination: z.string(),
        validitySeconds: intentValiditySchema.optional(),
      })
      .parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    validateAmount(body.amount);
    validateAsset(body.assetCode, body.assetIssuer ?? null);

    if (!StrKey.isValidEd25519PublicKey(body.destination)) {
      throw Errors.badRequest("invalid_destination", "Invalid destination public key");
    }

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const requiresMulti = (group.treasuryRequiredSigners ?? 1) > 1;
    const treasuryKey = group.treasuryAccountPublicKey!;

    return runIdempotent({
      userId: auth.id,
      scope: "treasury.withdraw",
      key: idempotencyKey,
      resourceId: id,
      payload: body,
      operation: async () => {
        const code = shortCode();
        const ttx = await prisma.treasuryTransaction.create({
          data: {
            shortCode: code,
            groupId: id,
            userId: auth.id,
            direction: "withdrawal",
            amount: body.amount,
            assetCode: body.assetCode,
            assetIssuer: body.assetIssuer ?? null,
            destination: body.destination,
            status: requiresMulti ? "awaiting_signatures" : "pending",
            memo: memoText(code),
          },
          include: { user: true },
        });

        const account = await stellar.loadAccount(treasuryKey);
        if (!account.exists) {
          throw Errors.badRequest("treasury_unfunded", "Treasury account is not funded");
        }
        const xdr = stellar.buildPayment({
          sourcePublicKey: treasuryKey,
          sourceSequence: account.sequence,
          destination: body.destination,
          asset: { code: body.assetCode, issuer: body.assetIssuer ?? null },
          amount: body.amount,
          memoCode: code,
        });

        return {
          treasuryTransaction: serializeTreasuryTx(ttx),
          xdr,
          networkPassphrase: config.networkPassphrase,
        };
      },
    });
  });

  // -- confirm treasury tx ----------------------------------------------------
  // Submitting a signed treasury envelope validates it and pushes it to
  // Horizon, so it gets its own budget rather than sharing one with the
  // treasury read routes — or with settlement submission.
  app.post("/treasury-transactions/:id/confirm", rateLimited("treasurySubmit"), async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

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

    // Checked after authorization (so a stranger learns nothing from the
    // difference) but before anything is sent upstream: an expired intent must
    // never be submitted to Horizon.
    assertIntentNotExpired(ttx.expiresAt, "treasury transaction");

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
        // submitPayment re-validates the envelope's own time bounds against the
        // stored intent, so a stale signature is rejected locally rather than
        // by Horizon.
        expiresAt: ttx.expiresAt,
        resource: "treasury transaction",
      });
    } catch (e) {
      await prisma.treasuryTransaction.update({
        where: { id },
        data: { status: "failed" },
      });
      if (e instanceof AppError) throw e;
      throw Errors.upstream("Transaction submission failed");
    }

    const updated = await prisma.treasuryTransaction.update({
      where: { id },
      data: { status: "confirmed", stellarTxHash: hash },
      include: { user: true },
    });
    await audit({
      userId: auth.id,
      scope: "treasury.confirm",
      key: idempotencyKey,
      resourceId: id,
      payload: body,
      operation: async (tx) => {
        const ttx = await tx.treasuryTransaction.findUnique({ where: { id } });
        if (!ttx) throw Errors.notFound("Treasury transaction not found");

        const group = await tx.group.findUnique({ where: { id: ttx.groupId } });
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
        } catch (e) {
          await tx.treasuryTransaction.update({
            where: { id },
            data: { status: "failed" },
          });
          throw e;
        }

        const updated = await tx.treasuryTransaction.update({
          where: { id },
          data: { status: "confirmed", stellarTxHash: hash },
          include: { user: true },
        });
        await audit({
          userId: auth.id,
          action: "treasury.confirm",
          entityType: "treasury_transaction",
          entityId: id,
          metadata: { hash, direction: ttx.direction },
        });
        return { treasuryTransaction: serializeTreasuryTx(updated) };
      },
    });
  });

  // -- history ----------------------------------------------------------------
  app.get("/groups/:id/treasury/history", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const { cursor, limit, order } = paginationQuerySchema.parse(req.query ?? {});
    await requireMembership(groupId, auth.id);

    const position = requireCursor(cursor);

    const transactions = await prisma.treasuryTransaction.findMany({
      where: { groupId, ...cursorFilter(position, order) },
      include: { user: true },
      orderBy: cursorOrderBy(order),
      take: takeForPage(limit),
    });

    const { items, meta } = buildPage(transactions, limit, order);
    return { transactions: items.map(serializeTreasuryTx), meta };
  });
}