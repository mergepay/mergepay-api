import { describe, it, expect } from "vitest";
import {
  computeShares,
  computeNetBalances,
  suggestSettlements,
  isAllSettled,
  type BalanceShareRow,
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
