/**
 * Settlement engine — pure functions, no I/O, fully unit-testable.
 *
 * Handles split computation, net balance derivation, and minimal settle-up
 * suggestions. All math runs in BigInt stroops (see money.ts).
 */

import { bigIntAbs, fromStroops, toStroops } from "./money";
import { isSupportedAsset } from "../lib/money";

export type SplitType = "equal" | "custom" | "percentage";

export interface ShareInput {
  userId: string;
  amount?: string; // custom
  percent?: number; // percentage
}

export interface ComputedShare {
  userId: string;
  shareAmount: string; // decimal string, 7dp-safe
}

/**
 * Split `amount` across participants according to `splitType`.
 * The first participant absorbs any rounding remainder so shares sum exactly.
 */
export function computeShares(
  amount: string,
  splitType: SplitType,
  shares: ShareInput[]
): ComputedShare[] {
  if (shares.length === 0) throw new Error("At least one participant required");
  const total = toStroops(amount);
  if (total <= 0n) throw new Error("Amount must be greater than zero");

  if (splitType === "custom") {
    const computed = shares.map((s) => {
      if (s.amount === undefined)
        throw new Error("custom split requires an amount per share");
      return { userId: s.userId, stroops: toStroops(s.amount) };
    });
    const sum = computed.reduce((a, c) => a + c.stroops, 0n);
    if (sum !== total) {
      throw new Error(
        `Custom amounts must sum to ${amount} (got ${fromStroops(sum)})`
      );
    }
    return computed.map((c) => ({
      userId: c.userId,
      shareAmount: fromStroops(c.stroops),
    }));
  }

  if (splitType === "percentage") {
    let pctTotal = 0;
    for (const s of shares) {
      if (s.percent === undefined)
        throw new Error("percentage split requires a percent per share");
      pctTotal += s.percent;
    }
    if (Math.abs(pctTotal - 100) > 0.001) {
      throw new Error(`Percentages must sum to 100 (got ${pctTotal})`);
    }
    const computed = shares.map((s) => {
      // total * percent / 100, in stroops
      const pctMilli = BigInt(Math.round((s.percent ?? 0) * 1000)); // 3dp of percent
      const stroops = (total * pctMilli) / 100000n;
      return { userId: s.userId, stroops };
    });
    return fixRemainder(computed, total);
  }

  // equal split
  const n = BigInt(shares.length);
  const base = total / n;
  const computed = shares.map((s) => ({ userId: s.userId, stroops: base }));
  return fixRemainder(computed, total);
}

function fixRemainder(
  computed: { userId: string; stroops: bigint }[],
  total: bigint
): ComputedShare[] {
  const sum = computed.reduce((a, c) => a + c.stroops, 0n);
  const remainder = total - sum;
  if (computed.length > 0) computed[0].stroops += remainder;
  return computed.map((c) => ({
    userId: c.userId,
    shareAmount: fromStroops(c.stroops),
  }));
}

// ---------------------------------------------------------------------------
// Net balances
// ---------------------------------------------------------------------------

export interface BalanceShareRow {
  payerUserId: string;
  userId: string; // debtor (share owner)
  shareAmount: string;
  /** A share is only an outstanding debt when not yet settled. */
  settled: boolean;
}

export interface BalanceSettlementRow {
  fromUserId: string;
  toUserId: string;
  amount: string;
  /** Only confirmed settlements reduce debt. */
  confirmed: boolean;
}

export interface NetBalance {
  userId: string;
  /** Positive = is owed money; negative = owes money. Decimal string. */
  net: string;
}

/**
 * A share row tagged with the asset its amount is denominated in.
 *
 * A group can hold expenses in several assets (XLM and USDC), and a stroop of
 * one is not worth a stroop of another. Every amount therefore carries the
 * asset it belongs to so balances never net across currencies.
 */
export interface AssetBalanceShareRow extends BalanceShareRow {
  assetCode: string;
  assetIssuer: string | null;
}

/** A settlement row tagged with the asset it settles in. */
export interface AssetBalanceSettlementRow extends BalanceSettlementRow {
  assetCode: string;
  assetIssuer: string | null;
}

/** Net balances for a single asset within a group. */
export interface AssetNetBalances {
  assetCode: string;
  assetIssuer: string | null;
  balances: NetBalance[];
}

/**
 * Stable grouping key for an asset. The code is upper-cased so `xlm` and `XLM`
 * group together, while the issuer is kept verbatim so two assets that share a
 * code but not an issuer never collapse into one balance bucket.
 */
export function balanceAssetKey(
  assetCode: string,
  assetIssuer: string | null
): string {
  return `${assetCode.toUpperCase()}::${assetIssuer ?? ""}`;
}

/**
 * Validate that a settlement asset is one Mergepay supports — native XLM, or
 * the configured stablecoin (USDC).
 *
 * Throws on anything else so a stray asset code can never enter balance math
 * or be attached to a settlement transaction. This is the service-level guard
 * behind the request-level Zod checks (see `refineStellarAsset`); it exists for
 * values that reach the engine from the database rather than a request body.
 */
export function assertSupportedSettlementAsset(
  assetCode: string,
  assetIssuer: string | null
): void {
  if (!isSupportedAsset(assetCode, assetIssuer)) {
    throw new Error(
      `Unsupported settlement asset "${assetCode}"` +
        (assetIssuer ? ` (issuer ${assetIssuer})` : "")
    );
  }
}

/**
 * Net = (what others owe this user) - (what this user owes others).
 *
 * Each unsettled share where user != payer means the share owner owes the payer.
 * Confirmed settlements transfer value from->to and net the books.
 */
export function computeNetBalances(
  shares: BalanceShareRow[],
  settlements: BalanceSettlementRow[]
): NetBalance[] {
  const net = new Map<string, bigint>();
  const add = (userId: string, delta: bigint) =>
    net.set(userId, (net.get(userId) ?? 0n) + delta);

  for (const s of shares) {
    if (s.settled) continue;
    if (s.userId === s.payerUserId) continue; // you don't owe yourself
    const amt = toStroops(s.shareAmount);
    add(s.payerUserId, amt); // payer is owed
    add(s.userId, -amt); // debtor owes
  }

  for (const st of settlements) {
    if (!st.confirmed) continue;
    const amt = toStroops(st.amount);
    // Paying down a debt: debtor's negative net rises toward 0,
    // creditor's positive net falls toward 0.
    add(st.fromUserId, amt);
    add(st.toUserId, -amt);
  }

  return [...net.entries()].map(([userId, stroops]) => ({
    userId,
    net: fromStroops(stroops),
  }));
}

/**
 * Net balances segregated by asset.
 *
 * Each distinct asset gets its own balance sheet: an XLM debt can never offset
 * a USDC credit, because that would claim a debt was paid in a currency it was
 * not denominated in. Rows are grouped by `(assetCode, assetIssuer)` and each
 * group is netted independently with `computeNetBalances`.
 *
 * Every asset encountered is validated against the supported registry, so a
 * bad code surfaces as an error instead of a quietly mis-grouped balance.
 * Asset groups are returned in first-seen order, which keeps the output stable
 * for a given input and lets callers pick a "primary" asset if they need one.
 */
export function computeNetBalancesByAsset(
  shares: AssetBalanceShareRow[],
  settlements: AssetBalanceSettlementRow[]
): AssetNetBalances[] {
  interface Group {
    assetCode: string;
    assetIssuer: string | null;
    shares: BalanceShareRow[];
    settlements: BalanceSettlementRow[];
  }

  const groups = new Map<string, Group>();

  const groupFor = (
    assetCode: string,
    assetIssuer: string | null
  ): Group => {
    assertSupportedSettlementAsset(assetCode, assetIssuer);
    const key = balanceAssetKey(assetCode, assetIssuer);
    let group = groups.get(key);
    if (!group) {
      group = { assetCode, assetIssuer, shares: [], settlements: [] };
      groups.set(key, group);
    }
    return group;
  };

  for (const s of shares) {
    groupFor(s.assetCode, s.assetIssuer).shares.push({
      payerUserId: s.payerUserId,
      userId: s.userId,
      shareAmount: s.shareAmount,
      settled: s.settled,
    });
  }

  for (const st of settlements) {
    groupFor(st.assetCode, st.assetIssuer).settlements.push({
      fromUserId: st.fromUserId,
      toUserId: st.toUserId,
      amount: st.amount,
      confirmed: st.confirmed,
    });
  }

  return [...groups.values()]
    .map((g) => ({
      assetCode: g.assetCode,
      assetIssuer: g.assetIssuer,
      balances: computeNetBalances(g.shares, g.settlements),
    }))
    .filter((g) => g.balances.length > 0);
}

// ---------------------------------------------------------------------------
// Settle-up suggestions (greedy minimal transfers)
// ---------------------------------------------------------------------------

export interface Suggestion {
  fromUserId: string;
  toUserId: string;
  amount: string;
}

/**
 * Greedy debt simplification: repeatedly match the largest debtor with the
 * largest creditor. Produces at most (n-1) transfers that zero all balances.
 */
export function suggestSettlements(balances: NetBalance[]): Suggestion[] {
  const debtors: { userId: string; amount: bigint }[] = [];
  const creditors: { userId: string; amount: bigint }[] = [];

  for (const b of balances) {
    const stroops = toStroops(b.net);
    if (stroops < 0n) debtors.push({ userId: b.userId, amount: -stroops });
    else if (stroops > 0n) creditors.push({ userId: b.userId, amount: stroops });
  }

  debtors.sort((a, b) => (b.amount > a.amount ? 1 : -1));
  creditors.sort((a, b) => (b.amount > a.amount ? 1 : -1));

  const suggestions: Suggestion[] = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const debtor = debtors[i];
    const creditor = creditors[j];
    const transfer = debtor.amount < creditor.amount ? debtor.amount : creditor.amount;
    if (transfer > 0n) {
      suggestions.push({
        fromUserId: debtor.userId,
        toUserId: creditor.userId,
        amount: fromStroops(transfer),
      });
    }
    debtor.amount -= transfer;
    creditor.amount -= transfer;
    if (debtor.amount === 0n) i++;
    if (creditor.amount === 0n) j++;
  }

  return suggestions;
}

/** Public name used by the settlement preview API. */
export function calculateSimplifiedDebts(balances: NetBalance[]): Suggestion[] {
  return suggestSettlements(balances);
}

/** Convenience: are all balances effectively zero? */
export function isAllSettled(balances: NetBalance[]): boolean {
  return balances.every((b) => bigIntAbs(toStroops(b.net)) === 0n);
}
