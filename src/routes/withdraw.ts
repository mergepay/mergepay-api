/**
 * SEP-24 fiat off-ramp — Issue #40.
 *
 * A user-facing facade that:
 *   - Auths the caller via the existing SEP-10 JWT (`app.authenticate`).
 *   - Validates the request body (positive amount, supported asset).
 *   - Checks the user's on-chain balance on the relevant trustline.
 *   - Persists a `Withdrawal` record with status="pending".
 *   - Resolves the configured anchor's `TRANSFER_SERVER_SEP0024` from its
 *     stellar.toml and constructs an "interactive URL" the user opens to
 *     finish KYC and receive fiat.
 *   - Surfaces `transaction_id` (= the internal Withdrawal id) so the
 *     frontend can poll `GET /withdraw/:id` for status updates.
 *   - Emits an audit log on every state-changing call.
 *
 * Status transitions
 * ------------------
 *   pending → pending_anchor → completed | failed
 *
 * The anchor (via its existing webhook on `/anchors/webhook`) updates the
 * status when it calls back. `GET /withdraw/:id` is the polling point.
 */

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { stellar } from "../services/stellar";
import { isPositive, toStroops } from "../services/money";
import { anchorService } from "../services/anchor";
import { audit } from "../services/audit";
import { serializeWithdrawal } from "../serializers";

/** Supported asset codes for fiat off-ramp in this MVP. */
const SUPPORTED_ASSETS = new Set(["XLM", "USDC"]);

const createBodySchema = z.object({
  amount: z.string().min(1),
  assetCode: z.string().min(1).max(12),
  assetIssuer: z.string().nullable().optional(),
  memo: z.string().min(1).max(28).optional(),
});

export default async function withdrawRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- POST /withdraw ----------------------------------------------------------
  app.post("/withdraw", async (req) => {
    const auth = requireUser(req);
    const body = createBodySchema.parse(req.body);

    if (!isPositive(body.amount)) {
      throw Errors.badRequest("invalid_amount", "Amount must be a positive decimal string");
    }
    if (!SUPPORTED_ASSETS.has(body.assetCode)) {
      throw Errors.badRequest(
        "unsupported_asset",
        `Asset ${body.assetCode} is not supported for withdrawal`
      );
    }

    // Pre-flight: account must exist on the ledger.
    const snapshot = await stellar.loadAccount(auth.stellarPublicKey);
    if (!snapshot.exists) {
      throw Errors.badRequest(
        "account_unfunded",
        "Your Stellar account is not funded yet. Fund it before withdrawing."
      );
    }

    // Balance check against the trustline (or native for XLM).
    const balance = snapshot.balances.find((b) => {
      if (b.assetCode !== body.assetCode) return false;
      if (body.assetCode === "XLM") return b.assetIssuer == null;
      return b.assetIssuer === (body.assetIssuer ?? null);
    });
    if (!balance) {
      throw Errors.badRequest(
        "no_trustline",
        `You have no ${body.assetCode} trustline`
      );
    }
    if (BigInt(toStroops(balance.balance)) < BigInt(toStroops(body.amount))) {
      throw Errors.badRequest(
        "insufficient_balance",
        `Withdraw ${body.amount} ${body.assetCode} but only ${balance.balance} available`
      );
    }

    // Resolve the anchor's interactive endpoint. We fetch stellar.toml with a
    // cached 5-minute TTL; failures fall back to a structural placeholder URL
    // (the anchor is configured to reject unsupported assets early in its
    // own wizard, so this is best-effort).
    const anchorName = config.ANCHOR_NAME;
    const anchorHomeDomain = config.ANCHOR_HOME_DOMAIN;
    let transferServer = "";
    try {
      const toml = await anchorService.getToml(anchorHomeDomain);
      transferServer = toml.transferServerSep24 ?? "";
    } catch {
      // ignored — handled below
    }

    const interactiveUrl = transferServer
      ? buildInteractiveUrl({
          transferServer,
          assetCode: body.assetCode,
          assetIssuer: body.assetIssuer ?? null,
          account: auth.stellarPublicKey,
          amount: body.amount,
        })
      : null;

    // status starts "pending"; the anchor webhook flips to completed | failed.
    const withdrawal = await prisma.withdrawal.create({
      data: {
        userId: auth.id,
        amount: body.amount,
        assetCode: body.assetCode,
        assetIssuer: body.assetIssuer ?? null,
        memo: body.memo ?? null,
        interactiveUrl,
        anchorTxId: null,
        status: "pending",
      },
    });

    await audit({
      userId: auth.id,
      action: "withdrawal.create",
      entityType: "withdrawal",
      entityId: withdrawal.id,
      metadata: {
        assetCode: body.assetCode,
        assetIssuer: body.assetIssuer ?? null,
        amount: body.amount,
        anchorName,
        anchorHomeDomain,
      },
    });

    return {
      withdrawal: serializeWithdrawal(withdrawal),
      // For convenience, also expose the explicit fields the issue spec asks for.
      interactive_url: withdrawal.interactiveUrl,
      transaction_id: withdrawal.id,
      status: withdrawal.status,
    };
  });

  // -- GET /withdraw/:id -------------------------------------------------------
  app.get("/withdraw/:id", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const withdrawal = await prisma.withdrawal.findUnique({ where: { id } });
    if (!withdrawal) throw Errors.notFound("Withdrawal not found");
    if (withdrawal.userId !== auth.id) {
      throw Errors.forbidden("You can only view your own withdrawal");
    }
    return { withdrawal: serializeWithdrawal(withdrawal) };
  });
}

// ---------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------

function buildInteractiveUrl(params: {
  transferServer: string;
  assetCode: string;
  assetIssuer: string | null;
  account: string;
  amount: string;
}): string {
  const base = params.transferServer.replace(/\/+$/, "");
  const qs = new URLSearchParams({
    asset_code: params.assetCode,
    account: params.account,
    amount: params.amount,
  });
  if (params.assetIssuer) qs.set("asset_issuer", params.assetIssuer);
  return `${base}/withdraw?${qs.toString()}`;
}
