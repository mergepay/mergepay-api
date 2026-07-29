import { prisma } from "../db";
import {
  computeNetBalances,
  suggestSettlements,
  type BalanceShareRow,
  type BalanceSettlementRow,
  type NetBalance,
} from "./settlement";
import { getAssetConfig } from "./assets";

/**
 * The asset a group settles in: derived from its expenses, default XLM.
 * Uses the centralized asset configuration to ensure the returned code+issuer
 * pair is valid.
 */
export async function groupPrimaryAsset(
  groupId: string
): Promise<{ assetCode: string; assetIssuer: string | null }> {
  const latest = await prisma.expense.findFirst({
    where: { groupId },
    orderBy: { createdAt: "desc" },
    select: { assetCode: true, assetIssuer: true },
  });
  const code = latest?.assetCode ?? "XLM";
  const issuer = latest?.assetIssuer ?? null;
  // Validate via the central registry (throws if misconfigured at startup).
  const asset = getAssetConfig(code, issuer ?? undefined);
  return {
    assetCode: asset.code,
    assetIssuer: asset.issuer,
  };
}

/** Load the rows the settlement engine needs and compute net balances. */
export async function loadGroupBalances(groupId: string): Promise<NetBalance[]> {
  const [expenses, settlements] = await Promise.all([
    prisma.expense.findMany({
      where: { groupId },
      include: { shares: true },
    }),
    prisma.settlement.findMany({ where: { groupId } }),
  ]);

  const shareRows: BalanceShareRow[] = [];
  for (const e of expenses) {
    for (const s of e.shares) {
      shareRows.push({
        payerUserId: e.payerUserId,
        userId: s.userId,
        shareAmount: s.shareAmount.toString(),
        settled: s.status === "settled",
      });
    }
  }

  const settlementRows: BalanceSettlementRow[] = settlements.map((s) => ({
    fromUserId: s.fromUserId,
    toUserId: s.toUserId,
    amount: s.amount.toString(),
    confirmed: s.status === "confirmed",
  }));

  return computeNetBalances(shareRows, settlementRows);
}

export async function loadGroupBalancesWithSuggestions(groupId: string) {
  const balances = await loadGroupBalances(groupId);
  const suggestions = suggestSettlements(balances);
  return { balances, suggestions };
}

/** A single user's net in a group (used for group summaries). */
export async function userNetInGroup(
  groupId: string,
  userId: string
): Promise<string> {
  const balances = await loadGroupBalances(groupId);
  return balances.find((b) => b.userId === userId)?.net ?? "0";
}
