/**
 * Settlement engine — pure functions, no I/O, fully unit-testable.
 *
 * Handles split computation, net balance derivation, and minimal settle-up
 * suggestions. All math runs in BigInt stroops (see money.ts).
 */

import { bigIntAbs, fromStroops, toStroops } from "./money";

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
