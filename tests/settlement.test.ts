import { describe, it, expect } from "vitest";
import {
  computeShares,
  computeNetBalances,
  suggestSettlements,
  isAllSettled,
  type BalanceShareRow,
  type ComputedShare,
  type NetBalance,
  type Suggestion,
} from "../src/services/settlement";
import { toStroops } from "../src/services/money";

describe("computeShares", () => {
  it("splits equally and absorbs the remainder on the first share", () => {
    const shares = computeShares("10", "equal", [
      { userId: "a" },
      { userId: "b" },
      { userId: "c" },
    ]);
    // 10 / 3 = 3.3333333 each, first gets the remainder
    const sum = shares.reduce((s, c) => s + toStroops(c.shareAmount), 0n);
    expect(sum).toBe(toStroops("10"));
    expect(shares[0].shareAmount).toBe("3.3333334");
    expect(shares[1].shareAmount).toBe("3.3333333");
  });

  it("splits evenly when the amount divides exactly", () => {
    const shares = computeShares("9", "equal", [
      { userId: "a" },
      { userId: "b" },
      { userId: "c" },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["3", "3", "3"]);
  });

  it("keeps sub-stroop splits exact with a 1-stroop remainder", () => {
    const shares = computeShares("0.01", "equal", [
      { userId: "a" },
      { userId: "b" },
      { userId: "c" },
    ]);
    const sum = shares.reduce((s, c) => s + toStroops(c.shareAmount), 0n);
    expect(sum).toBe(toStroops("0.01"));
    expect(shares[0].shareAmount).toBe("0.0033334");
    expect(shares[1].shareAmount).toBe("0.0033333");
  });

  it("handles a single participant", () => {
    const shares = computeShares("42.5", "equal", [{ userId: "a" }]);
    expect(shares).toEqual([{ userId: "a", shareAmount: "42.5" }]);
  });

  it("accepts a single custom share equal to the total", () => {
    const shares = computeShares("30", "custom", [{ userId: "a", amount: "30" }]);
    expect(shares).toEqual([{ userId: "a", shareAmount: "30" }]);
  });

  it("rejects a zero amount", () => {
    expect(() => computeShares("0", "equal", [{ userId: "a" }])).toThrow(
      /greater than zero/
    );
  });

  it("rejects a negative amount", () => {
    expect(() => computeShares("-10", "equal", [{ userId: "a" }])).toThrow(
      /greater than zero/
    );
  });

  it("rejects an empty participant list", () => {
    expect(() => computeShares("10", "equal", [])).toThrow(
      /At least one participant/
    );
  });

  it("accepts custom amounts that sum to the total", () => {
    const shares = computeShares("30", "custom", [
      { userId: "a", amount: "10" },
      { userId: "b", amount: "20" },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["10", "20"]);
  });

  it("rejects custom amounts that don't sum to the total", () => {
    expect(() =>
      computeShares("30", "custom", [
        { userId: "a", amount: "10" },
        { userId: "b", amount: "15" },
      ])
    ).toThrow(/sum/);
  });

  it("splits by percentage and fixes rounding", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);
    const sum = shares.reduce((s, c) => s + toStroops(c.shareAmount), 0n);
    expect(sum).toBe(toStroops("100"));
  });

  it("assigns exact percentage shares for a 3-way split", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["33.33", "33.33", "33.34"]);
  });

  it("accepts percentages within the 0.001 tolerance", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 33.333 },
      { userId: "b", percent: 33.333 },
      { userId: "c", percent: 33.334 },
    ]);
    const sum = shares.reduce((s, c) => s + toStroops(c.shareAmount), 0n);
    expect(sum).toBe(toStroops("100"));
  });

  it("rejects percentages that don't total 100", () => {
    expect(() =>
      computeShares("100", "percentage", [
        { userId: "a", percent: 50 },
        { userId: "b", percent: 40 },
      ])
    ).toThrow(/100/);
  });
});

describe("computeNetBalances", () => {
  it("derives who owes whom from unsettled shares", () => {
    const shares: BalanceShareRow[] = [
      { payerUserId: "a", userId: "a", shareAmount: "10", settled: true },
      { payerUserId: "a", userId: "b", shareAmount: "10", settled: false },
      { payerUserId: "a", userId: "c", shareAmount: "10", settled: false },
    ];
    const balances = computeNetBalances(shares, []);
    const byUser = Object.fromEntries(balances.map((b) => [b.userId, b.net]));
    expect(byUser.a).toBe("20"); // owed 20
    expect(byUser.b).toBe("-10");
    expect(byUser.c).toBe("-10");
  });

  it("reduces debt when settlements are confirmed", () => {
    const shares: BalanceShareRow[] = [
      { payerUserId: "a", userId: "b", shareAmount: "10", settled: false },
    ];
    const balances = computeNetBalances(shares, [
      { fromUserId: "b", toUserId: "a", amount: "10", confirmed: true },
    ]);
    const byUser = Object.fromEntries(balances.map((b) => [b.userId, b.net]));
    expect(byUser.a).toBe("0");
    expect(byUser.b).toBe("0");
  });

  it("ignores unconfirmed settlements", () => {
    const shares: BalanceShareRow[] = [
      { payerUserId: "a", userId: "b", shareAmount: "10", settled: false },
    ];
    const balances = computeNetBalances(shares, [
      { fromUserId: "b", toUserId: "a", amount: "10", confirmed: false },
    ]);
    const byUser = Object.fromEntries(balances.map((b) => [b.userId, b.net]));
    expect(byUser.b).toBe("-10");
  });
});

describe("suggestSettlements", () => {
  it("produces transfers that zero out all balances", () => {
    const balances = [
      { userId: "a", net: "30" },
      { userId: "b", net: "-20" },
      { userId: "c", net: "-10" },
    ];
    const suggestions = suggestSettlements(balances);

    // Apply suggestions back as confirmed settlements; everyone should be square.
    const result = computeNetBalances(
      [],
      suggestions.map((s) => ({
        fromUserId: s.fromUserId,
        toUserId: s.toUserId,
        amount: s.amount,
        confirmed: true,
      }))
    );
    // Net effect of suggestions vs original should cancel.
    const original = new Map(balances.map((b) => [b.userId, toStroops(b.net)]));
    for (const r of result) {
      const orig = original.get(r.userId) ?? 0n;
      expect(orig + toStroops(r.net)).toBe(0n);
    }
  });

  it("returns no suggestions when all settled", () => {
    const balances = [
      { userId: "a", net: "0" },
      { userId: "b", net: "0" },
    ];
    expect(suggestSettlements(balances)).toHaveLength(0);
    expect(isAllSettled(balances)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #656 — debt simplification: circular debts, the documented (n-1) bound, and
// the edges that must degrade to an empty plan rather than an exception.
// ---------------------------------------------------------------------------

/**
 * What each participant is left with once a suggestion set is applied.
 *
 * A suggestion is consumed as a confirmed settlement row, so the arithmetic
 * here is `computeNetBalances`' own settlement convention: paying down a debt
 * raises the payer's negative net and lowers the payee's positive one. Everyone
 * at zero is the only definition of "minimal *and* correct" — the simplifier is
 * allowed to cut the number of transactions, never to leave somebody still
 * owing because a rounding remainder or a tie-break went missing.
 */
function residualByUser(
  balances: NetBalance[],
  suggestions: Suggestion[]
): Map<string, bigint> {
  const residual = new Map<string, bigint>();
  for (const b of balances) residual.set(b.userId, toStroops(b.net));
  for (const s of suggestions) {
    const amount = toStroops(s.amount);
    residual.set(s.fromUserId, (residual.get(s.fromUserId) ?? 0n) + amount);
    residual.set(s.toUserId, (residual.get(s.toUserId) ?? 0n) - amount);
  }
  return residual;
}

/** The count a bound is actually measured against: participants with a debt or credit. */
const unsettledCount = (balances: NetBalance[]) =>
  balances.filter((b) => toStroops(b.net) !== 0n).length;

/**
 * Asserts one suggestion set is a complete, sane settle-up plan: every
 * transfer is positive and not paid to yourself, the whole group is square
 * afterwards, and the count respects the (n-1) bound `suggestSettlements`
 * documents for the first time in this suite.
 */
function expectMinimalAndSettled(balances: NetBalance[], suggestions: Suggestion[]) {
  for (const s of suggestions) {
    expect(toStroops(s.amount), `${s.fromUserId}->${s.toUserId} moves no value`).toBeGreaterThan(
      0n
    );
    expect(s.fromUserId, "a transfer that pays someone themselves").not.toBe(s.toUserId);
  }

  const residual = residualByUser(balances, suggestions);
  expect(
    [...residual.keys()].sort(),
    "a participant in the plan that was not on the books"
  ).toEqual([...balances.map((b) => b.userId)].sort());
  for (const [userId, stroops] of residual) {
    expect(stroops, `${userId} still owes after applying the plan`).toBe(0n);
  }

  const withADebt = unsettledCount(balances);
  if (withADebt > 0) {
    expect(
      suggestions.length,
      `${suggestions.length} transfers for ${withADebt} unsettled members breaks the (n-1) bound`
    ).toBeLessThanOrEqual(withADebt - 1);
  } else {
    expect(suggestions).toHaveLength(0);
  }
}

/** Shares as the ledger stores them once one member fronted the whole expense. */
const sharedBy = (
  payerUserId: string,
  computed: ComputedShare[]
): BalanceShareRow[] =>
  computed.map((c) => ({
    payerUserId,
    userId: c.userId,
    shareAmount: c.shareAmount,
    settled: false,
  }));

describe("suggestSettlements — circular debts collapse (#656)", () => {
  it("needs no transfer at all for a balanced ring", () => {
    // a fronted 10 for b, b fronted 10 for c, c fronted 10 for a: three edges
    // of real debt, and nothing to pay. The netting step — not the greedy one —
    // is what removes the cycle, and this is the case a peer-to-peer "pay every
    // edge" settlement would get wrong by spending three ledger fees.
    const balances = computeNetBalances(
      [
        { payerUserId: "a", userId: "b", shareAmount: "10", settled: false },
        { payerUserId: "b", userId: "c", shareAmount: "10", settled: false },
        { payerUserId: "c", userId: "a", shareAmount: "10", settled: false },
      ],
      []
    );

    expect(Object.fromEntries(balances.map((b) => [b.userId, b.net]))).toEqual({
      a: "0",
      b: "0",
      c: "0",
    });
    expect(suggestSettlements(balances)).toEqual([]);
    expect(isAllSettled(balances)).toBe(true);
  });

  it("turns an uneven ring into fewer transfers than there were edges", () => {
    const balances = computeNetBalances(
      [
        { payerUserId: "a", userId: "b", shareAmount: "30", settled: false },
        { payerUserId: "b", userId: "c", shareAmount: "20", settled: false },
        { payerUserId: "c", userId: "a", shareAmount: "10", settled: false },
      ],
      []
    );
    const suggestions = suggestSettlements(balances);

    // a is owed 20; b and c each owe 10 — so two transfers clear three edges.
    expect(Object.fromEntries(balances.map((b) => [b.userId, b.net]))).toEqual({
      a: "20",
      b: "-10",
      c: "-10",
    });
    expect(suggestions.length).toBeLessThan(3);
    expectMinimalAndSettled(balances, suggestions);
  });

  it("clears a four-member ring with exactly three transfers", () => {
    const balances = computeNetBalances(
      [
        { payerUserId: "a", userId: "b", shareAmount: "40", settled: false },
        { payerUserId: "b", userId: "c", shareAmount: "30", settled: false },
        { payerUserId: "c", userId: "d", shareAmount: "20", settled: false },
        { payerUserId: "d", userId: "a", shareAmount: "10", settled: false },
      ],
      []
    );
    const suggestions = suggestSettlements(balances);

    expectMinimalAndSettled(balances, suggestions);
    // One creditor against three equal debtors: the bound is met, not merely
    // respected — there is no plan with fewer transfers here.
    expect(suggestions.length).toBe(3);
    expect(suggestions.map((s) => s.toUserId).every((to) => to === "a")).toBe(true);
  });

  it("settles a ring where one member both owes and is owed", () => {
    const balances = computeNetBalances(
      [
        { payerUserId: "a", userId: "b", shareAmount: "25", settled: false },
        { payerUserId: "b", userId: "a", shareAmount: "5", settled: false },
      ],
      []
    );
    const suggestions = suggestSettlements(balances);

    // The two directions between the same pair net to a single payment, which
    // is the smallest possible cycle and the one a naive per-edge settlement
    // would send twice.
    expect(Object.fromEntries(balances.map((b) => [b.userId, b.net]))).toEqual({
      a: "20",
      b: "-20",
    });
    expectMinimalAndSettled(balances, suggestions);
    expect(suggestions).toEqual([{ fromUserId: "b", toUserId: "a", amount: "20" }]);
  });
});

describe("suggestSettlements — the (n-1) bound the engine documents (#656)", () => {
  const shapes: Array<[string, NetBalance[]]> = [
    ["one creditor and one debtor", [{ userId: "a", net: "10" }, { userId: "b", net: "-10" }]],
    [
      "a star: one creditor, four debtors",
      [
        { userId: "a", net: "40" },
        { userId: "b", net: "-10" },
        { userId: "c", net: "-10" },
        { userId: "d", net: "-10" },
        { userId: "e", net: "-10" },
      ],
    ],
    [
      "a chain of unequal splits",
      [
        { userId: "a", net: "1.5" },
        { userId: "b", net: "-7.25" },
        { userId: "c", net: "12" },
        { userId: "d", net: "-4.25" },
        { userId: "e", net: "-2" },
      ],
    ],
    [
      "every debtor owing the same amount",
      [
        { userId: "a", net: "20" },
        { userId: "b", net: "10" },
        { userId: "c", net: "-10" },
        { userId: "d", net: "-10" },
        { userId: "e", net: "-10" },
      ],
    ],
    [
      "a ten-member group with a zero-net member",
      [
        { userId: "a", net: "0" },
        { userId: "b", net: "5" },
        { userId: "c", net: "-5" },
        { userId: "d", net: "7" },
        { userId: "e", net: "-1" },
        { userId: "f", net: "-3" },
        { userId: "g", net: "2" },
        { userId: "h", net: "-8" },
        { userId: "i", net: "4" },
        { userId: "j", net: "-1" },
      ],
    ],
  ];

  it.each(shapes)("settles %s completely within the bound", (_label, balances) => {
    expectMinimalAndSettled(balances, suggestSettlements(balances));
  });

  it.each(shapes)("is stable across input order for %s", (_label, balances) => {
    // The plan is compared by the value it moves, not by which tied creditor it
    // picked: equal amounts are ordered by V8's sort, and the amount each member
    // ends up paying or receiving is what the engine actually guarantees.
    const totalMoved = (suggestions: Suggestion[]) =>
      suggestions.reduce((sum, s) => sum + toStroops(s.amount), 0n);
    const reversed = [...balances].reverse();

    const forward = suggestSettlements(balances);
    const backward = suggestSettlements(reversed);

    expectMinimalAndSettled(reversed, backward);
    expect(totalMoved(backward)).toBe(totalMoved(forward));
    expect(backward.length).toBeLessThanOrEqual(unsettledCount(balances) - 1);
  });

  it("never invents a transfer for a member who has nothing to settle", () => {
    const balances: NetBalance[] = [
      { userId: "a", net: "0" },
      { userId: "b", net: "0" },
      { userId: "c", net: "10" },
      { userId: "d", net: "-10" },
    ];
    const suggestions = suggestSettlements(balances);

    expect(suggestions).toEqual([{ fromUserId: "d", toUserId: "c", amount: "10" }]);
    expectMinimalAndSettled(balances, suggestions);
  });
});

describe("suggestSettlements — edges that must not throw (#656)", () => {
  it("accepts an empty balance sheet", () => {
    expect(() => suggestSettlements([])).not.toThrow();
    expect(suggestSettlements([])).toEqual([]);
    expect(isAllSettled([])).toBe(true);
  });

  it("accepts a single-member group", () => {
    const balances: NetBalance[] = [{ userId: "solo", net: "0" }];
    expect(() => suggestSettlements(balances)).not.toThrow();
    expect(suggestSettlements(balances)).toEqual([]);
  });

  it("settles nobody when a lone member has an unmatched credit", () => {
    // Not a ledger state a group can reach — balances always sum to zero — but
    // the answer to it must be an empty plan rather than a transfer out of (or
    // into) nowhere.
    const balances: NetBalance[] = [{ userId: "solo", net: "10" }];
    expect(() => suggestSettlements(balances)).not.toThrow();
    expect(suggestSettlements(balances)).toEqual([]);
  });

  it("clears a one-stroop imbalance exactly", () => {
    const balances: NetBalance[] = [
      { userId: "a", net: "0.0000001" },
      { userId: "b", net: "-0.0000001" },
    ];
    const suggestions = suggestSettlements(balances);

    expect(suggestions).toEqual([{ fromUserId: "b", toUserId: "a", amount: "0.0000001" }]);
    expectMinimalAndSettled(balances, suggestions);
  });

  it("leaves the ledger whole: what the debtors owe is exactly what the plan moves", () => {
    const balances: NetBalance[] = [
      { userId: "a", net: "0.0033334" },
      { userId: "b", net: "-0.0033333" },
      { userId: "c", net: "-0.0033333" },
      { userId: "d", net: "0.0033332" },
    ];
    const suggestions = suggestSettlements(balances);
    const owed = balances
      .filter((b) => toStroops(b.net) < 0n)
      .reduce((sum, b) => sum - toStroops(b.net), 0n);

    expect(suggestions.reduce((sum, s) => sum + toStroops(s.amount), 0n)).toBe(owed);
    expectMinimalAndSettled(balances, suggestions);
  });
});

describe("suggestSettlements — split remainders still settle to the stroop (#656)", () => {
  it("clears an equal split of 10 among three members", () => {
    // 10/3 is not representable: the first member absorbs the remainder, so the
    // debts are 3.3333333 each and one member carries the extra stroop.
    const shares = sharedBy("a", computeShares("10", "equal", [{ userId: "a" }, { userId: "b" }, { userId: "c" }]));
    const balances = computeNetBalances(shares, []);
    const suggestions = suggestSettlements(balances);

    expectMinimalAndSettled(balances, suggestions);
    expect(suggestions).toHaveLength(2);
  });

  it("clears a percentage split truncated down to a single stroop", () => {
    // One stroop split 50/25/25 truncates every share to zero and the remainder
    // helper hands the whole stroop to the first participant — so exactly one
    // member owes anything, and the plan must move precisely that stroop.
    const shares = sharedBy(
      "b",
      computeShares("0.0000001", "percentage", [
        { userId: "a", percent: 50 },
        { userId: "b", percent: 25 },
        { userId: "c", percent: 25 },
      ])
    );
    const balances = computeNetBalances(shares, []);
    const suggestions = suggestSettlements(balances);

    expectMinimalAndSettled(balances, suggestions);
    // Every stroop the split assigned is accounted for by the plan.
    const moved = suggestions.reduce((sum, s) => sum + toStroops(s.amount), 0n);
    const credited = balances
      .filter((b) => toStroops(b.net) > 0n)
      .reduce((sum, b) => sum + toStroops(b.net), 0n);
    expect(moved).toBe(credited);
    expect(moved).toBe(1n);
  });

  it("clears an unequal custom split", () => {
    const shares = sharedBy(
      "paid_by",
      computeShares("100", "custom", [
        { userId: "a", amount: "50" },
        { userId: "b", amount: "30" },
        { userId: "c", amount: "20" },
      ])
    );
    const balances = computeNetBalances(shares, []);
    const suggestions = suggestSettlements(balances);

    expectMinimalAndSettled(balances, suggestions);
    expect(suggestions).toHaveLength(3);
    expect(suggestions.every((s) => s.toUserId === "paid_by")).toBe(true);
  });

  it("does not re-propose debt that was already settled in part", () => {
    const shares: BalanceShareRow[] = [
      { payerUserId: "a", userId: "b", shareAmount: "10", settled: false },
      { payerUserId: "a", userId: "c", shareAmount: "10", settled: false },
    ];
    const balances = computeNetBalances(shares, [
      { fromUserId: "b", toUserId: "a", amount: "10", confirmed: true },
    ]);
    const suggestions = suggestSettlements(balances);

    expect(suggestions).toEqual([{ fromUserId: "c", toUserId: "a", amount: "10" }]);
    expectMinimalAndSettled(balances, suggestions);
  });
});
