import { FastifyInstance } from "fastify";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { stellarAccountIdSchema } from "../lib/stellar-validation";
import { config } from "../config";
import { AppError, Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership, requireAdmin } from "../services/access";
import { stellar, memoText } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit, auditTx } from "../services/audit";
import { AuditAction } from "../services/audit-actions";
import { validateAsset, validateAmount } from "../services/assets";
import { rateLimited } from "../lib/rate-limit";
import {
  assertIntentNotExpired,
  intentExpiry,
  intentValiditySchema,
  secondsUntilExpiry,
} from "../lib/time-bounds";
import { serializeGroup, serializeTreasuryTx } from "../serializers";
import {
  buildPage,
  cursorFilter,
  cursorOrderBy,
  paginationQuerySchema,
  requireCursor,
  takeForPage,
} from "../lib/pagination";
import { readIdempotencyKey, runIdempotent } from "../services/idempotency";
import {
  assertSignedXdrMatchesIntent,
  getTreasuryAccount,
  getTreasuryAccountSnapshot,
  getTreasuryMultisigRequirement,
  hashOfEnvelope,
} from "../services/treasury-stellar";
import {
  validateProposedSignerConfig,
  validateSignerChangeAgainstAccount,
  snapshotToSignerConfig,
  type ProposedSignerConfig,
} from "../services/treasury-validation";
import { treasurySignerConfigSchema } from "../validations/treasury";
import { openApiBody, openApiEnvelope, openApiIdParams } from "../lib/openapi";

const stellarAmountSchema = z.string().min(1);

export default async function treasuryRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- enable -----------------------------------------------------------------
  app.post(
    "/groups/:id/treasury/enable",
    {
      schema: {
        tags: ["Treasury"],
        summary: "Enable group treasury",
        description:
          "Enables multi-signature treasury for a group with a designated Stellar public key.",
        params: openApiIdParams(),
        body: openApiBody(
          z.object({
            publicKey: stellarAccountIdSchema,
            requiredSigners: z.number().int().min(1).max(20).optional(),
          })
        ),
        response: openApiEnvelope("group"),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        publicKey: stellarAccountIdSchema,
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

    // The admin check and the update happen in one transaction so a
    // concurrent demotion/removal of `auth.id` can't bypass authorization.
    const group = await prisma.$transaction(async (tx) => {
      await requireAdmin(id, auth.id, tx);
      // Read inside the transaction so the audit entry records the
      // configuration this call actually replaced.
      const existing = await tx.group.findUnique({ where: { id } });
      const updated = await tx.group.update({
        where: { id },
        data: {
          treasuryEnabled: true,
          treasuryAccountPublicKey: body.publicKey,
          treasuryRequiredSigners: body.requiredSigners ?? 1,
        },
      });
      await auditTx(tx, {
        userId: auth.id,
        groupId: id,
        action: AuditAction.TREASURY_ENABLE,
        entityType: "group",
        entityId: id,
        outcome: "success",
        // The multisig configuration is the security-relevant part of this
        // change: the signing threshold decides how many approvals it takes
        // to move funds, so an audit needs to see what it was set to and what
        // it replaced, not merely that the treasury was touched.
        metadata: {
          treasuryAccountPublicKey: body.publicKey,
          previousRequiredSigners: existing?.treasuryRequiredSigners ?? null,
          requiredSigners: body.requiredSigners ?? 1,
          previouslyEnabled: existing?.treasuryEnabled ?? false,
        },
      });
      return updated;
    });
    return { group: serializeGroup(group) };
  });

  // -- info -------------------------------------------------------------------
  app.get(
    "/groups/:id/treasury",
    {
      schema: {
        tags: ["Treasury"],
        summary: "Get group treasury status",
        description: "Returns treasury account public key, balances, signers, and thresholds.",
        params: openApiIdParams(),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const view = await getTreasuryAccount(group.treasuryAccountPublicKey);
    return {
      publicKey: view.publicKey,
      balances: view.balances,
      signers: view.signers,
      thresholds: view.thresholds,
    };
  });

  // -- validate signer config -------------------------------------------------
  app.post(
    "/groups/:id/treasury/validate-signers",
    {
      schema: {
        tags: ["Treasury"],
        summary: "Validate treasury signer configuration",
        description:
          "Validates proposed signer set and threshold changes against the Stellar network state.",
        params: openApiIdParams(),
        body: openApiBody(treasurySignerConfigSchema),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireAdmin(id, auth.id);
    
    const body = treasurySignerConfigSchema.parse(req.body);

    const group = await prisma.group.findUnique({ where: { id } });
    if (!group?.treasuryEnabled || !group.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    const snapshot = await getTreasuryAccountSnapshot(group.treasuryAccountPublicKey);

    const proposedConfig: ProposedSignerConfig = {
      signers: body.signers,
      thresholds: body.thresholds,
    };

    const validation = validateProposedSignerConfig(proposedConfig, snapshot);
    
    await audit({
      userId: auth.id,
      groupId: id,
      action: AuditAction.TREASURY_SIGNER_VALIDATION,
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
  app.post(
    "/groups/:id/treasury/deposit",
    {
      ...rateLimited("settlementCreate"),
      schema: {
        tags: ["Treasury"],
        summary: "Initiate treasury deposit",
        description: "Creates an unsigned deposit intent transaction for a group treasury.",
        params: openApiIdParams(),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const body = z
      .object({
        amount: stellarAmountSchema,
        assetCode: z.string().min(1).max(12),
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
    await requireMembership(id, auth.id);
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
      operation: async (tx) => {
        const code = shortCode();
        const { expiresAt, validitySeconds } = intentExpiry(body.validitySeconds);

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
          validitySeconds,
        });

        // Compute the transaction hash so the confirm endpoint can validate
        // the submitted signed XDR is for this exact intent.
        const intendedTxHash = hashOfEnvelope(xdr);

        const ttx = await tx.treasuryTransaction.create({
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
            expiresAt,
            intendedTxHash,
          },
          include: { user: true },
        });

        // The audit row is written through the same transaction as the state
        // change (issue #367): a best-effort write here would survive a
        // rollback and orphan an entry for a deposit that never happened.
        await auditTx(tx, {
          userId: auth.id,
          groupId: id,
          action: AuditAction.TREASURY_DEPOSIT_CREATE,
          entityType: "treasury_transaction",
          entityId: ttx.id,
          metadata: {
            amount: body.amount,
            assetCode: body.assetCode,
            assetIssuer: body.assetIssuer ?? null,
            destination: treasuryKey,
          },
        });


        return {
          treasuryTransaction: serializeTreasuryTx(ttx),
          xdr,
          expiresAt: expiresAt.toISOString(),
          expiresInSeconds: secondsUntilExpiry(expiresAt),
          networkPassphrase: config.networkPassphrase,
        };
      },
    });
  });

  // -- withdraw ---------------------------------------------------------------
  app.post(
    "/groups/:id/treasury/withdraw",
    {
      ...rateLimited("settlementCreate"),
      schema: {
        tags: ["Treasury"],
        summary: "Propose treasury withdrawal",
        description: "Creates a withdrawal proposal requiring multi-signature approval.",
        params: openApiIdParams(),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(id, auth.id);
    const body = z
      .object({
        amount: stellarAmountSchema,
        assetCode: z.string().min(1).max(12),
        assetIssuer: z.string().nullable().optional(),
        destination: z.string(),
        validitySeconds: intentValiditySchema.optional(),
      })
      .parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    validateAmount(body.amount);
    validateAsset(body.assetCode, body.assetIssuer ?? null);

    if (!StrKey.isValidEd25519PublicKey(body.destination)) {
      throw Errors.badRequest("invalid_destination", "Not a valid Stellar public key");
    }

    const group = await prisma.group.findUnique({ where: { id } });
    await requireMembership(id, auth.id);
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
      operation: async (tx) => {
        const code = shortCode();
        const { expiresAt, validitySeconds } = intentExpiry(body.validitySeconds);

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
          validitySeconds,
        });

        // Compute the transaction hash so the confirm endpoint can validate
        // the submitted signed XDR is for this exact intent.
        const intendedTxHash = hashOfEnvelope(xdr);

        const ttx = await tx.treasuryTransaction.create({
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
            expiresAt,
            intendedTxHash,
          },
          include: { user: true },
        });

        // The audit row is written through the same transaction as the state
        // change (issue #367): a best-effort write here would survive a
        // rollback and orphan an entry for a withdrawal that never happened.
        await auditTx(tx, {
          userId: auth.id,
          groupId: id,
          action: AuditAction.TREASURY_WITHDRAW_CREATE,
          entityType: "treasury_transaction",
          entityId: ttx.id,
          metadata: {
            amount: body.amount,
            assetCode: body.assetCode,
            assetIssuer: body.assetIssuer ?? null,
            destination: body.destination,
          },
        });


        return {
          treasuryTransaction: serializeTreasuryTx(ttx),
          expiresAt: expiresAt.toISOString(),
          expiresInSeconds: secondsUntilExpiry(expiresAt),
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
  app.post(
    "/treasury-transactions/:id/confirm",
    {
      ...rateLimited("treasurySubmit"),
      schema: {
        tags: ["Treasury"],
        summary: "Confirm treasury transaction",
        description: "Submits signatures and confirms execution of a treasury transaction.",
        params: openApiIdParams(),
      },
    },
    async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);
    const idempotencyKey = readIdempotencyKey(req.headers);

    const ttx = await prisma.treasuryTransaction.findUnique({ where: { id } });
    if (!ttx) throw Errors.notFound("Treasury transaction not found");

    // Authorize from the transaction's persisted group before reading treasury
    // configuration or accepting any signed envelope. Deposits are additionally
    // owned by their creator; withdrawals require an administrator.
    if (ttx.direction === "deposit") {
      await requireMembership(ttx.groupId, auth.id);
      if (ttx.userId !== auth.id) {
        throw Errors.forbidden("Only the depositor can confirm this deposit");
      }
      await requireMembership(ttx.groupId, auth.id);
    } else {
      await requireAdmin(ttx.groupId, auth.id);
    }
    const group = await prisma.group.findUnique({ where: { id: ttx.groupId } });
    if (!group?.treasuryAccountPublicKey) {
      throw Errors.badRequest("treasury_disabled", "Treasury is not enabled");
    }

    if (ttx.status === "confirmed") {
      return { treasuryTransaction: serializeTreasuryTx(ttx) };
    }

    // Checked after authorization (so a stranger learns nothing from the
    // difference) but before anything is sent upstream: an expired intent must
    // never be submitted to Horizon.
    assertIntentNotExpired(ttx.expiresAt, "treasury transaction");

    const treasuryAccountPublicKey = group.treasuryAccountPublicKey;
    const source = ttx.direction === "deposit" ? auth.stellarPublicKey : treasuryAccountPublicKey;
    const destination = ttx.direction === "deposit" ? treasuryAccountPublicKey : ttx.destination!;

    // A withdrawal spends from the shared treasury account, so it must carry
    // signatures from the account's own configured co-signers (checked
    // against the threshold on file), not just a single valid signature.
    let multisig: { signers: string[]; threshold: number } | null = null;
    if (ttx.direction === "withdrawal") {
      multisig = await getTreasuryMultisigRequirement(
        treasuryAccountPublicKey,
        group.treasuryRequiredSigners ?? 1
      );
    }

    return runIdempotent({
      userId: auth.id,
      scope: "treasury.confirm",
      key: idempotencyKey,
      resourceId: id,
      payload: body,
      operation: async (tx) => {
        const fresh = await tx.treasuryTransaction.findUnique({ where: { id } });
        if (!fresh) throw Errors.notFound("Treasury transaction not found");
        if (fresh.status === "confirmed") {
          return { treasuryTransaction: serializeTreasuryTx(fresh) };
        }

        // Validate the submitted signed XDR is for the exact intended
        // transaction. This prevents a signer from submitting a signature
        // for a modified (attacker-changed) transaction.
        if (fresh.intendedTxHash) {
          assertSignedXdrMatchesIntent(body.signedXdr, fresh.intendedTxHash);
        }

        let hash: string;
        try {
          const expected = {
            sourcePublicKey: source,
            destination,
            asset: { code: fresh.assetCode, issuer: fresh.assetIssuer },
            amount: fresh.amount.toString(),
            memoCode: fresh.shortCode,
            expiresAt: fresh.expiresAt,
            resource: "treasury transaction",
          };
          hash = multisig
            ? await stellar.submitMultisigPayment(body.signedXdr, expected, multisig)
            : await stellar.submitPayment(body.signedXdr, expected);
        } catch (e) {
          await tx.treasuryTransaction.update({
            where: { id },
            data: { status: "failed" },
          });
          await auditTx(tx, {
            userId: auth.id,
            groupId: fresh.groupId,
            action: AuditAction.TREASURY_CONFIRM_FAILED,
            entityType: "treasury_transaction",
            entityId: id,
            outcome: "failure",
            metadata: {
              direction: fresh.direction,
              reason: e instanceof Error ? e.message : String(e),
            },
          });
          if (e instanceof AppError) throw e;
          throw Errors.upstream("Transaction submission failed");
        }

        const updated = await tx.treasuryTransaction.update({
          where: { id },
          data: { status: "confirmed", stellarTxHash: hash },
          include: { user: true },
        });
        await auditTx(tx, {
          userId: auth.id,
          groupId: fresh.groupId,
          action: AuditAction.TREASURY_CONFIRM,
          entityType: "treasury_transaction",
          entityId: id,
          metadata: { hash, direction: fresh.direction },
        });
        return { treasuryTransaction: serializeTreasuryTx(updated) };
      },
    });
  });

  // -- history ----------------------------------------------------------------
  app.get(
    "/groups/:id/treasury/history",
    {
      schema: {
        tags: ["Treasury"],
        summary: "Get treasury transaction history",
        description: "Returns paginated transaction history for a group treasury.",
        params: openApiIdParams(),
      },
    },
    async (req) => {
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
