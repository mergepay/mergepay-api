import { prisma } from "../db";
import {
  balanceAssetKey,
  computeNetBalancesByAsset,
  suggestSettlements,
  type AssetBalanceShareRow,
  type AssetBalanceSettlementRow,
  type AssetNetBalances,
  type NetBalance,
  type Suggestion,
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

/**
 * Load the raw share and settlement rows the engine needs, each tagged with the
 * asset it is denominated in.
 *
 * An expense carries the asset for the whole bill, so every one of its shares
 * inherits it — the payer and each participant owe in the same currency the
 * expense was recorded in. Settlements carry their own asset.
 */
async function loadAssetBalanceRows(groupId: string): Promise<{
  shares: AssetBalanceShareRow[];
  settlements: AssetBalanceSettlementRow[];
}> {
  const [expenses, settlements] = await Promise.all([
    prisma.expense.findMany({
      where: { groupId },
      include: { shares: true },
    }),
    prisma.settlement.findMany({ where: { groupId } }),
  ]);

  const shares: AssetBalanceShareRow[] = [];
  for (const e of expenses) {
    for (const s of e.shares) {
      shares.push({
        payerUserId: e.payerUserId,
        userId: s.userId,
        shareAmount: s.shareAmount.toString(),
        settled: s.status === "settled",
        assetCode: e.assetCode,
        assetIssuer: e.assetIssuer ?? null,
      });
    }
  }

  const settlementRows: AssetBalanceSettlementRow[] = settlements.map((s) => ({
    fromUserId: s.fromUserId,
    toUserId: s.toUserId,
    amount: s.amount.toString(),
    confirmed: s.status === "confirmed",
    assetCode: s.assetCode,
    assetIssuer: s.assetIssuer ?? null,
  }));

  return { shares, settlements: settlementRows };
}

/**
 * Compute a group's net balances, segregated per asset.
 *
 * A group can hold XLM and USDC expenses side by side. Netting them together
 * would let a USDC debt cancel an XLM credit, so each asset gets its own
 * balance sheet and settle-up suggestions are produced per asset.
 */
export async function loadGroupBalancesByAsset(
  groupId: string
): Promise<AssetNetBalances[]> {
  const { shares, settlements } = await loadAssetBalanceRows(groupId);
  return computeNetBalancesByAsset(shares, settlements);
}

/**
 * The group's net balances for its primary asset only.
 *
 * Kept for callers that surface a single "your net" figure alongside the
 * group's primary asset (see `groupPrimaryAsset`). Callers that need every
 * asset should use `loadGroupBalancesByAsset` instead.
 */
export async function loadGroupBalances(groupId: string): Promise<NetBalance[]> {
  const [byAsset, primary] = await Promise.all([
    loadGroupBalancesByAsset(groupId),
    groupPrimaryAsset(groupId),
  ]);
  const key = balanceAssetKey(primary.assetCode, primary.assetIssuer);
  return (
    byAsset.find((g) => balanceAssetKey(g.assetCode, g.assetIssuer) === key)
      ?.balances ?? []
  );
}

export interface AssetBalancesWithSuggestions extends AssetNetBalances {
  suggestions: Suggestion[];
}

/**
 * Per-asset balances plus the minimal set of transfers that would settle each
 * asset. Suggestions are computed independently per asset — a transfer that
 * settles an XLM debt says nothing about a USDC one.
 */
export async function loadGroupBalancesWithSuggestionsByAsset(
  groupId: string
): Promise<AssetBalancesWithSuggestions[]> {
  const byAsset = await loadGroupBalancesByAsset(groupId);
  return byAsset.map((assetBalances) => ({
    ...assetBalances,
    suggestions: suggestSettlements(assetBalances.balances),
  }));
}

/**
 * Balances and suggestions for the group's primary asset only.
 *
 * Kept for existing single-asset callers; use
 * `loadGroupBalancesWithSuggestionsByAsset` to cover every asset in the group.
 */
export async function loadGroupBalancesWithSuggestions(groupId: string) {
  const [byAsset, primary] = await Promise.all([
    loadGroupBalancesWithSuggestionsByAsset(groupId),
    groupPrimaryAsset(groupId),
  ]);
  const key = balanceAssetKey(primary.assetCode, primary.assetIssuer);
  const match = byAsset.find(
    (g) => balanceAssetKey(g.assetCode, g.assetIssuer) === key
  );
  return {
    balances: match?.balances ?? [],
    suggestions: match?.suggestions ?? [],
  };
}

/** A single user's net in a group's primary asset (used for group summaries). */
export async function userNetInGroup(
  groupId: string,
  userId: string
): Promise<string> {
  const balances = await loadGroupBalances(groupId);
  return balances.find((b) => b.userId === userId)?.net ?? "0";
}
