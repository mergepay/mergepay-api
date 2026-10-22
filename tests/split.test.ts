/**
 * Split calculation tests — rounding must be deterministic and lossless.
 *
 * Expenses are divided in integer stroops (1e7 per unit), never in floats.
 * Whenever a division does not come out even, `computeShares` awards the
 * leftover stroops to the first participant (the payer when the payer is
 * listed first), so the shares always sum to exactly the original total.
 */
import { describe, it, expect } from "vitest";
import {
  computeShares,
  type ComputedShare,
  type ShareInput,
} from "../src/services/settlement";
import { toStroops } from "../src/services/money";

const STROOPS = 10_000_000n;

function participants(count: number): ShareInput[] {
  return Array.from({ length: count }, (_, i) => ({ userId: `u${i + 1}` }));
}

function sumStroops(shares: ComputedShare[]): bigint {
  return shares.reduce((acc, s) => acc + toStroops(s.shareAmount), 0n);
}

function expectExactTotal(shares: ComputedShare[], amount: string): void {
  expect(sumStroops(shares)).toBe(toStroops(amount));
}

/** Totals chosen to exercise prime stroop counts and high precision. */
const TOTALS = [
  "0.0000007", // a single-digit stroop total
  "0.0999983", // prime number of stroops (999983)
  "0.0007919", // prime number of stroops (7919)
  "0.0104729", // prime number of stroops (104729)
  "1",
  "7",
  "13.37",
  "0.3",
  "100",
  "12345.6789012", // full 7dp precision
  "922337203685.4775783", // near the maximum ledger amount
];

const PARTICIPANT_COUNTS = [3, 4, 5, 7];

describe("computeShares: equal split rounding", () => {
  it("produces identical shares when the amount divides exactly", () => {
    expect(
      computeShares("100", "equal", participants(4)).map((s) => s.shareAmount)
    ).toEqual(["25", "25", "25", "25"]);

    expect(
      computeShares("0.3", "equal", participants(3)).map((s) => s.shareAmount)
    ).toEqual(["0.1", "0.1", "0.1"]);

    expect(
      computeShares("9", "equal", participants(3)).map((s) => s.shareAmount)
    ).toEqual(["3", "3", "3"]);
  });

  it("awards every leftover stroop to the first participant", () => {
    const shares = computeShares("100", "equal", participants(3));
    // 100 / 3 = 33.3333333r stroops; the first share absorbs the extra stroop.
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "33.3333334",
      "33.3333333",
      "33.3333333",
    ]);
    expectExactTotal(shares, "100");
  });

  it("gives every non-first participant the truncated floor share", () => {
    for (const amount of TOTALS) {
      for (const count of PARTICIPANT_COUNTS) {
        const shares = computeShares(amount, "equal", participants(count));
        const total = toStroops(amount);
        const base = total / BigInt(count);

        for (const share of shares.slice(1)) {
          expect(toStroops(share.shareAmount)).toBe(base);
        }
        // First share = total - (n - 1) * floor(total / n), i.e. the remainder
        // (always less than one stroop per extra participant) lands here.
        expect(toStroops(shares[0].shareAmount)).toBe(
          total - base * BigInt(count - 1)
        );
        expect(toStroops(shares[0].shareAmount)).toBeGreaterThanOrEqual(base);
        expectExactTotal(shares, amount);
      }
    }
  });

  it("never loses or invents a stroop for prime amounts among 3+ participants", () => {
    for (const amount of TOTALS) {
      for (const count of PARTICIPANT_COUNTS) {
        const shares = computeShares(amount, "equal", participants(count));
        expect(shares).toHaveLength(count);
        expectExactTotal(shares, amount);
        for (const share of shares) {
          expect(toStroops(share.shareAmount)).toBeGreaterThanOrEqual(0n);
        }
      }
    }
  });

  it("handles a total smaller than the participant count", () => {
    const shares = computeShares("0.0000001", "equal", participants(3));
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0000001",
      "0",
      "0",
    ]);
    expectExactTotal(shares, "0.0000001");
  });

  it("splits amounts that floating-point math would botch", () => {
    const shares = computeShares("0.1", "equal", participants(3));
    // 1e6 stroops / 3 = 333333.33r → 0.0333333 each, +1 stroop on the first.
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0333334",
      "0.0333333",
      "0.0333333",
    ]);
    expectExactTotal(shares, "0.1");
  });

  it("stays exact at the maximum ledger amount", () => {
    const shares = computeShares(
      "922337203685.4775807",
      "equal",
      participants(3)
    );
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "307445734561.8258603",
      "307445734561.8258602",
      "307445734561.8258602",
    ]);
    expectExactTotal(shares, "922337203685.4775807");
  });

  it("returns identical results on repeated calls", () => {
    for (const amount of TOTALS) {
      for (const count of PARTICIPANT_COUNTS) {
        const first = computeShares(amount, "equal", participants(count));
        const second = computeShares(amount, "equal", participants(count));
        expect(second).toEqual(first);
      }
    }
  });

  it("keeps participant order and ids", () => {
    const shares = computeShares("10", "equal", [
      { userId: "alice" },
      { userId: "bob" },
      { userId: "carol" },
    ]);
    expect(shares.map((s) => s.userId)).toEqual(["alice", "bob", "carol"]);
  });
});

describe("computeShares: percentage split rounding", () => {
  it("assigns exact shares when percentages divide evenly", () => {
    const shares = computeShares("10", "percentage", [
      { userId: "a", percent: 50 },
      { userId: "b", percent: 50 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["5", "5"]);
    expectExactTotal(shares, "10");
  });

  it("gives the leftover stroop to the first participant", () => {
    const shares = computeShares("0.000001", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);
    // 10 stroops split 33.33/33.33/33.34 floors to 3/3/3; the first takes +1.
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0000004",
      "0.0000003",
      "0.0000003",
    ]);
    expectExactTotal(shares, "0.000001");
  });

  it("always totals the original expense amount", () => {
    const cases: Array<{ amount: string; percents: number[] }> = [
      { amount: "100", percents: [33.33, 33.33, 33.34] },
      { amount: "100", percents: [33.333, 33.333, 33.334] },
      { amount: "0.01", percents: [10, 20, 30, 40] },
      { amount: "7", percents: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 25, 25] },
      { amount: "12345.6789012", percents: [50, 50] },
      { amount: "922337203685.4775783", percents: [60, 40] },
    ];
    for (const { amount, percents } of cases) {
      const shares = computeShares(
        amount,
        "percentage",
        percents.map((percent, i) => ({ userId: `u${i + 1}`, percent }))
      );
      expect(shares).toHaveLength(percents.length);
      expectExactTotal(shares, amount);
      for (const share of shares) {
        expect(toStroops(share.shareAmount)).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it("returns identical results on repeated calls", () => {
    const build = (): ShareInput[] => [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ];
    const first = computeShares("0.07", "percentage", build());
    const second = computeShares("0.07", "percentage", build());
    expect(second).toEqual(first);
    expectExactTotal(first, "0.07");
  });

  it("assigns the whole amount to a single 100% participant", () => {
    const shares = computeShares("42.5", "percentage", [
      { userId: "a", percent: 100 },
    ]);
    expect(shares).toEqual([{ userId: "a", shareAmount: "42.5" }]);
  });
});

describe("computeShares: custom split totals", () => {
  it("preserves exact custom amounts, order, and total", () => {
    const shares = computeShares("10.0000003", "custom", [
      { userId: "a", amount: "3.3333333" },
      { userId: "b", amount: "3.3333333" },
      { userId: "c", amount: "3.3333337" },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "3.3333333",
      "3.3333333",
      "3.3333337",
    ]);
    expect(shares.map((s) => s.userId)).toEqual(["a", "b", "c"]);
    expectExactTotal(shares, "10.0000003");
  });

  it("rejects custom amounts that miss the total by a single stroop", () => {
    expect(() =>
      computeShares("10", "custom", [
        { userId: "a", amount: "3.3333333" },
        { userId: "b", amount: "3.3333333" },
        { userId: "c", amount: "3.3333332" },
      ])
    ).toThrow(/sum to 10/);
  });
});
