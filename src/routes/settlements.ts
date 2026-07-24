import crypto from "node:crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";
import { requireUser } from "../plugins/auth";
import { requireMembership } from "../services/access";
import { stellar } from "../services/stellar";
import { shortCode } from "../services/codes";
import { audit } from "../services/audit";
import {
  serializeSettlement,
  serializeExpense,
  serializeTreasuryTx,
} from "../serializers";
import {
  loadGroupBalancesWithSuggestions,
  groupPrimaryAsset,
} from "../services/group-balances";
import { memoText } from "../services/stellar";

const settlementInclude = { from: true, to: true } as const;

export default async function settlementRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // -- settle a specific expense share ----------------------------------------
  app.post("/expenses/:id/settle", async (req) => {
    const auth = requireUser(req);
    const { id: expenseId } = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        assetCode: z.string().optional(),
        assetIssuer: z.string().nullable().optional(),
      })
      .parse(req.body ?? {});

    const expense = await prisma.expense.findUnique({
      where: { id: expenseId },
      include: { shares: true, payer: true },
    });
    if (!expense) throw Errors.notFound("Expense not found");
    await requireMembership(expense.groupId, auth.id);

    const myShare = expense.shares.find((s) => s.userId === auth.id);
    if (!myShare) throw Errors.badRequest("no_share", "You have no share in this expense");
    if (myShare.status === "settled") {
      throw Errors.conflict("already_settled", "Your share is already settled");
    }
    if (expense.payerUserId === auth.id) {
      throw Errors.badRequest("payer_share", "You are the payer of this expense");
    }

    const assetCode = body.assetCode ?? expense.assetCode;
    const assetIssuer =
      body.assetCode !== undefined ? body.assetIssuer ?? null : expense.assetIssuer;

    const code = shortCode();
    const settlement = await prisma.settlement.create({
      data: {
        shortCode: code,
        groupId: expense.groupId,
        fromUserId: auth.id,
        toUserId: expense.payerUserId,
        amount: myShare.shareAmount,
        assetCode,
        assetIssuer,
        status: "pending",
        memo: memoText(code),
        expenseId: expense.id,
        expenseShareId: myShare.id,
      },
      include: settlementInclude,
    });

    await prisma.expenseShare.update({
      where: { id: myShare.id },
      data: { status: "settling" },
    });

    const xdr = await buildSettlementXdr({
      fromPublicKey: auth.stellarPublicKey,
      toPublicKey: expense.payer.stellarPublicKey,
      assetCode,
      assetIssuer,
      amount: myShare.shareAmount.toString(),
      memoCode: code,
    });

    return {
      settlement: serializeSettlement(settlement),
      xdr,
      networkPassphrase: config.networkPassphrase,
    };
  });

  // -- freeform settle-up against net balance ---------------------------------
  app.post("/groups/:id/settlements", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);
    const body = z
      .object({
        toUserId: z.string(),
        amount: z.string().min(1),
        assetCode: z.string().min(1),
        assetIssuer: z.string().nullable().optional(),
      })
      .parse(req.body);

    if (body.toUserId === auth.id) {
      throw Errors.badRequest("self_settle", "You cannot settle with yourself");
    }
    const recipient = await prisma.groupMember.findUnique({
      where: { groupId_userId: { groupId, userId: body.toUserId } },
      include: { user: true },
    });
    if (!recipient) throw Errors.badRequest("invalid_recipient", "Recipient is not a member");

    const code = shortCode();
    const settlement = await prisma.settlement.create({
      data: {
        shortCode: code,
        groupId,
        fromUserId: auth.id,
        toUserId: body.toUserId,
        amount: body.amount,
        assetCode: body.assetCode,
        assetIssuer: body.assetIssuer ?? null,
        status: "pending",
        memo: memoText(code),
      },
      include: settlementInclude,
    });

    const xdr = await buildSettlementXdr({
      fromPublicKey: auth.stellarPublicKey,
      toPublicKey: recipient.user.stellarPublicKey,
      assetCode: body.assetCode,
      assetIssuer: body.assetIssuer ?? null,
      amount: body.amount,
      memoCode: code,
    });

    return {
      settlement: serializeSettlement(settlement),
      xdr,
      networkPassphrase: config.networkPassphrase,
    };
  });

  // -- confirm (submit signed xdr) --------------------------------------------
  app.post("/settlements/:id/confirm", async (req, reply) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = z.object({ signedXdr: z.string().min(1) }).parse(req.body);

    const idempotencyKey = (req.headers["idempotency-key"] as string | undefined) ?? null;
    const requestHash = idempotencyKey
      ? crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")
      : null;

    if (idempotencyKey) {
      const existing = await prisma.idempotencyKey.findUnique({
        where: { key: idempotencyKey },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          return reply.code(409).send({
            error: "idempotency_conflict",
            message: "Idempotency key already used with a different request body",
            statusCode: 409,
            requestId: req.id as string,
          });
        }
        return reply.code(200).send(JSON.parse(existing.responseJson));
      }
    }

    const settlement = await prisma.settlement.findUnique({
      where: { id },
      include: { from: true, to: true },
    });
    if (!settlement) throw Errors.notFound("Settlement not found");
    if (settlement.fromUserId !== auth.id) {
      throw Errors.forbidden("Only the payer can confirm this settlement");
    }
    if (settlement.status === "confirmed") {
      const response200 = { settlement: serializeSettlement(settlement) };
      if (idempotencyKey) {
        await prisma.idempotencyKey.create({
          data: {
            key: idempotencyKey,
            requestHash: requestHash!,
            responseJson: JSON.stringify(response200),
          },
        });
      }
      return response200;
    }

    let hash: string;
    try {
      hash = await stellar.submitPayment(body.signedXdr, {
        sourcePublicKey: settlement.from.stellarPublicKey,
        destination: settlement.to.stellarPublicKey,
        asset: { code: settlement.assetCode, issuer: settlement.assetIssuer },
        amount: settlement.amount.toString(),
        memoCode: settlement.shortCode,
      });
    } catch (e) {
      await prisma.settlement.update({
        where: { id },
        data: { status: "failed" },
      });
      throw e;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const s = await tx.settlement.update({
        where: { id },
        data: { status: "confirmed", stellarTxHash: hash },
        include: settlementInclude,
      });
      if (settlement.expenseShareId) {
        await tx.expenseShare.update({
          where: { id: settlement.expenseShareId },
          data: { status: "settled" },
        });
      }
      return s;
    });

    await audit({
      userId: auth.id,
      action: "settlement.confirm",
      entityType: "settlement",
      entityId: id,
      metadata: { hash },
    });

    const response200 = { settlement: serializeSettlement(updated) };
    if (idempotencyKey) {
      await prisma.idempotencyKey.create({
        data: {
          key: idempotencyKey,
          requestHash: requestHash!,
          responseJson: JSON.stringify(response200),
        },
      });
    }
    return response200;
  });

  // -- balances + suggestions -------------------------------------------------
  app.get("/groups/:id/balances", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const { balances, suggestions } = await loadGroupBalancesWithSuggestions(groupId);

    const userIds = new Set<string>();
    balances.forEach((b) => userIds.add(b.userId));
    suggestions.forEach((s) => {
      userIds.add(s.fromUserId);
      userIds.add(s.toUserId);
    });
    const users = await prisma.user.findMany({
      where: { id: { in: [...userIds] } },
    });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const asset = await groupPrimaryAsset(groupId);

    return {
      balances: balances
        .filter((b) => userMap.has(b.userId))
        .map((b) => ({
          userId: b.userId,
          user: serializeUserSafe(userMap.get(b.userId)),
          net: b.net,
          assetCode: asset.assetCode,
        })),
      suggestions: suggestions.map((s) => ({
        fromUserId: s.fromUserId,
        from: serializeUserSafe(userMap.get(s.fromUserId)),
        toUserId: s.toUserId,
        to: serializeUserSafe(userMap.get(s.toUserId)),
        amount: s.amount,
        assetCode: asset.assetCode,
        assetIssuer: asset.assetIssuer,
      })),
    };
  });

  // -- ledger -----------------------------------------------------------------
  app.get("/groups/:id/ledger", async (req) => {
    const auth = requireUser(req);
    const { id: groupId } = z.object({ id: z.string() }).parse(req.params);
    await requireMembership(groupId, auth.id);

    const [expenses, settlements, treasuryTxs] = await Promise.all([
      prisma.expense.findMany({
        where: { groupId },
        include: { payer: true, shares: { include: { user: true } } },
      }),
      prisma.settlement.findMany({
        where: { groupId },
        include: { from: true, to: true },
      }),
      prisma.treasuryTransaction.findMany({
        where: { groupId },
        include: { user: true },
      }),
    ]);

    const entries = [
      ...expenses.map((e) => ({
        type: "expense" as const,
        createdAt: e.createdAt.toISOString(),
        expense: serializeExpense(e),
      })),
      ...settlements.map((s) => ({
        type: "settlement" as const,
        createdAt: s.createdAt.toISOString(),
        settlement: serializeSettlement(s),
      })),
      ...treasuryTxs.map((t) => ({
        type: "treasury" as const,
        createdAt: t.createdAt.toISOString(),
        treasuryTransaction: serializeTreasuryTx(t),
      })),
    ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    return { entries };
  });
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function buildSettlementXdr(params: {
  fromPublicKey: string;
  toPublicKey: string;
  assetCode: string;
  assetIssuer: string | null;
  amount: string;
  memoCode: string;
}): Promise<string> {
  const account = await stellar.loadAccount(params.fromPublicKey);
  if (!account.exists) {
    throw Errors.badRequest(
      "account_unfunded",
      "Your Stellar account is not funded yet. Fund it before settling."
    );
  }
  return stellar.buildPayment({
    sourcePublicKey: params.fromPublicKey,
    sourceSequence: account.sequence,
    destination: params.toPublicKey,
    asset: { code: params.assetCode, issuer: params.assetIssuer },
    amount: params.amount,
    memoCode: params.memoCode,
  });
}

function serializeUserSafe(u: any) {
  return u
    ? {
        id: u.id,
        stellarPublicKey: u.stellarPublicKey,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl ?? null,
        createdAt: u.createdAt.toISOString(),
      }
    : null;
}
