import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    user: { findMany: vi.fn() },
    anchorSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    withdrawal: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    auditLog: { create: vi.fn() },
    statusHistory: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { applyAnchorSessionTransition } from "../../src/services/anchor-status";
import { AuditAction } from "../../src/services/audit-actions";
import {
  accountPublicKeys,
  anchorTransactionAuditMetadata,
  sep24CallbackAuditMetadata,
  sep24LifecycleAction,
  sep24StartAction,
} from "../../src/services/sep24-audit";
import { applyWithdrawalTransition } from "../../src/services/withdrawal-status";

const prisma = h.prisma;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SEP-24 audit vocabulary (issue #1079)", () => {
  it("distinguishes deposit and withdrawal start/completion/failure actions", () => {
    expect(sep24StartAction("deposit")).toBe(AuditAction.ANCHOR_DEPOSIT_STARTED);
    expect(sep24StartAction("withdrawal")).toBe(AuditAction.ANCHOR_WITHDRAWAL_STARTED);
    expect(sep24LifecycleAction("deposit", "completed")).toBe(
      AuditAction.ANCHOR_DEPOSIT_COMPLETED
    );
    expect(sep24LifecycleAction("withdrawal", "completed")).toBe(
      AuditAction.ANCHOR_WITHDRAWAL_COMPLETED
    );
    expect(sep24LifecycleAction("deposit", "no_market")).toBe(
      AuditAction.ANCHOR_DEPOSIT_FAILED
    );
    expect(sep24LifecycleAction("withdrawal", "expired")).toBe(
      AuditAction.ANCHOR_WITHDRAWAL_FAILED
    );
    expect(sep24LifecycleAction("deposit", "pending_anchor")).toBeUndefined();
  });

  it("normalizes callback and anchor-response trace fields without secrets", () => {
    const callbackMetadata = sep24CallbackAuditMetadata({
      externalTransactionId: "tx_1",
      rawStatus: "completed",
      message: null,
      stellarTransactionId: " stellar-tx-hash ",
      amountIn: "100.25",
      amountOut: null,
      amountFee: "0.5",
    });
    expect(callbackMetadata).toMatchObject({
      rawStatus: "completed",
      stellarTransactionId: "stellar-tx-hash",
      amountIn: "100.25",
      amountFee: "0.5",
    });
    expect(callbackMetadata).not.toHaveProperty("jwt");
    expect(callbackMetadata).not.toHaveProperty("anchorToken");

    expect(
      anchorTransactionAuditMetadata({
        status: "completed",
        stellar_transaction_id: "hash_2",
        amount_in: "10",
        amount_out: "9.9",
        amount_fee: "0.1",
        amount_in_asset: "USDC",
      })
    ).toMatchObject({
      rawStatus: "completed",
      stellarTransactionId: "hash_2",
      amountIn: "10",
      amountOut: "9.9",
      amountFee: "0.1",
      assetCode: "USDC",
    });
  });

  it("resolves the account owner's public key for audit attribution", async () => {
    prisma.user.findMany.mockResolvedValueOnce([
      { id: "user_1", stellarPublicKey: "GPUBLICKEY" },
    ]);

    const keys = await accountPublicKeys(["user_1", "user_1"]);

    expect(keys.get("user_1")).toBe("GPUBLICKEY");
    expect(prisma.user.findMany).toHaveBeenCalledWith({
      where: { id: { in: ["user_1"] } },
      select: { id: true, stellarPublicKey: true },
    });
  });
});

describe("SEP-24 state transition audit records (issue #1079)", () => {
  it("writes a deposit lifecycle audit with hash, amounts, asset, and actor key", async () => {
    prisma.anchorSession.findUnique.mockResolvedValueOnce({
      id: "session_1",
      userId: "user_1",
      status: "pending_anchor",
      assetCode: "USDC",
      kind: "deposit",
    });

    await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "webhook",
      auditAction: AuditAction.ANCHOR_DEPOSIT_COMPLETED,
      auditMetadata: {
        stellarTransactionId: "stellar-hash",
        amountIn: "100.25",
        amountFee: "0.5",
      },
      actorPublicKey: "GACCOUNTKEY",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: AuditAction.ANCHOR_DEPOSIT_COMPLETED,
        entityType: "anchor_session",
        entityId: "session_1",
        metadata: expect.objectContaining({
          actorPublicKey: "GACCOUNTKEY",
          from: "pending_anchor",
          to: "completed",
          assetCode: "USDC",
          stellarTransactionId: "stellar-hash",
          amountIn: "100.25",
          amountFee: "0.5",
        }),
      }),
    });
  });

  it("writes a withdrawal lifecycle audit with hash, amounts, asset, and actor key", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce({
      id: "wth_1",
      userId: "user_1",
      status: "processing",
      assetCode: "XLM",
      amount: "5",
      anchorTxId: "anchor-hash",
    });

    await applyWithdrawalTransition({
      withdrawalId: "wth_1",
      nextStatus: "completed",
      source: "webhook",
      auditAction: AuditAction.ANCHOR_WITHDRAWAL_COMPLETED,
      auditMetadata: { amountOut: "4.9", amountFee: "0.1" },
      actorPublicKey: "GACCOUNTKEY",
    });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: AuditAction.ANCHOR_WITHDRAWAL_COMPLETED,
        entityType: "withdrawal",
        entityId: "wth_1",
        metadata: expect.objectContaining({
          actorPublicKey: "GACCOUNTKEY",
          from: "processing",
          to: "completed",
          assetCode: "XLM",
          amount: "5",
          stellarTransactionId: "anchor-hash",
          amountOut: "4.9",
          amountFee: "0.1",
        }),
      }),
    });
  });
});
