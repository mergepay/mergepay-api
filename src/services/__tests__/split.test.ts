/**
 * Split rounding determinism — unit tests for `computeShares`.
 *
 * A group expense divides one total among N participants. Whenever the total
 * is not a multiple of N, the division leaves a remainder counted in stroops
 * (10^-7 of a unit). These tests pin down the rules the settlement engine
 * applies so a cent is never created or destroyed by the split:
 *
 *   - all arithmetic runs in BigInt stroops, never floating point;
 *   - every share except the first is floored to `total / n`;
 *   - the entire remainder lands on the first participant;
 *   - the shares always sum back to exactly the original expense total.
 *
 * The file deliberately drives `computeShares` with prime stroop totals and
 * prime-ish decimal amounts across three or more participants, because those
 * are the inputs where a float implementation drifts.
 */
import { describe, it, expect } from "vitest";
import { computeShares, type ShareInput } from "../settlement";
import { toStroops, MAX_STROOPS } from "../money";

/** `count` participants with stable, order-preserving ids. */
const participants = (count: number): ShareInput[] =>
  Array.from({ length: count }, (_, i) => ({ userId: `u${i + 1}` }));

/** Sum of computed shares, measured back in integer stroops. */
const stroopsOf = (shares: { shareAmount: string }[]): bigint =>
  shares.reduce((sum, share) => sum + toStroops(share.shareAmount), 0n);

/** Canonical API amounts carry at most 7 decimal places. */
const CANONICAL_AMOUNT = /^\d+(?:\.\d{1,7})?$/;

describe("computeShares — equal split rounding", () => {
  it("divides exactly when the total is a multiple of the participant count", () => {
    const shares = computeShares("9", "equal", participants(3));

    expect(shares.map((s) => s.shareAmount)).toEqual(["3", "3", "3"]);
    expect(stroopsOf(shares)).toBe(toStroops("9"));
  });

  it("floors every share and gives the entire remainder to the first participant", () => {
    const shares = computeShares("10", "equal", participants(3));

    const total = toStroops("10"); // 100_000_000 stroops
    const base = total / 3n; // 33_333_333 stroops
    expect(shares.map((s) => toStroops(s.shareAmount))).toEqual([
      base + 1n, // 3.3333334
      base, // 3.3333333
      base, // 3.3333333
    ]);
    expect(stroopsOf(shares)).toBe(total);
  });

  it("keeps the remainder on the first entry of the share list (payer-first order)", () => {
    const shares = computeShares("10", "equal", [
      { userId: "payer" },
      { userId: "b" },
      { userId: "c" },
    ]);

    expect(shares[0]).toEqual({ userId: "payer", shareAmount: "3.3333334" });
    expect(shares[1].shareAmount).toBe("3.3333333");
    expect(shares[2].shareAmount).toBe("3.3333333");
    expect(stroopsOf(shares)).toBe(toStroops("10"));
  });

  it("never splits by floating point (0.1 across 3 stays an exact 0.1 total)", () => {
    const shares = computeShares("0.1", "equal", participants(3));

    // Naive float math yields 0.0333333333 * 3 = 0.09999999999. Integer
    // stroops instead yield 333_333 each with the 1-stroop remainder on the
    // first share, which sums back to exactly 0.1.
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0333334",
      "0.0333333",
      "0.0333333",
    ]);
    expect(stroopsOf(shares)).toBe(toStroops("0.1"));
  });

  it("is deterministic: identical input always produces identical shares", () => {
    const first = computeShares("97.77", "equal", participants(7));
    const second = computeShares("97.77", "equal", participants(7));

    expect(second).toEqual(first);
  });

  it("keeps no state between calls of different splits", () => {
    const a = computeShares("10", "equal", participants(3));
    computeShares("100", "equal", participants(7));
    const aAgain = computeShares("10", "equal", participants(3));

    expect(aAgain).toEqual(a);
  });
});

describe("computeShares — prime amounts across three or more participants", () => {
  it.each([
    ["0.0000007", 3, [3n, 2n, 2n]],
    ["0.0000011", 5, [3n, 2n, 2n, 2n, 2n]],
    ["0.0000013", 4, [4n, 3n, 3n, 3n]],
    ["0.0000017", 6, [7n, 2n, 2n, 2n, 2n, 2n]],
    ["97", 3, [323333334n, 323333333n, 323333333n]],
  ] as const)("%s split among %i participants is exact", (amount, count, expected) => {
    const shares = computeShares(amount, "equal", participants(count));

    expect(shares.map((s) => toStroops(s.shareAmount))).toEqual([...expected]);
    expect(stroopsOf(shares)).toBe(toStroops(amount));
  });

  it("spreads the whole remainder onto the first share, keeping others floored", () => {
    // 11 stroops among 5: floor is 2, remainder 11 - 2*5 = 1.
    const shares = computeShares("0.0000011", "equal", participants(5));
    const stroops = shares.map((s) => toStroops(s.shareAmount));

    expect(stroops[0]).toBe(3n);
    expect(stroops.slice(1)).toEqual([2n, 2n, 2n, 2n]);
    expect(stroops[0] - stroops[1]).toBe(1n); // bounded by the remainder
  });

  it("bounds the spread between the largest and smallest share to n-1 stroops", () => {
    // 97 stroops among 4 leaves a 1-stroop remainder; no share may drift by
    // more than that remainder, which is what a float split would do.
    const shares = computeShares("0.0000097", "equal", participants(4));
    const stroops = shares.map((s) => toStroops(s.shareAmount));
    const remainder = toStroops("0.0000097") % 4n;

    expect(stroops[0] - stroops[1]).toBe(remainder);
    expect(stroops.slice(1).every((v) => v === stroops[1])).toBe(true);
  });

  it("assigns the whole tiny total to the first participant when n does not fit", () => {
    // 1 stroop cannot be shared by 5 without going sub-stroop: the first
    // participant absorbs it and the others get 0, but the total is preserved.
    const shares = computeShares("0.0000001", "equal", participants(5));

    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0000001",
      "0",
      "0",
      "0",
      "0",
    ]);
    expect(stroopsOf(shares)).toBe(1n);
  });
});

describe("computeShares — total conservation across the split matrix", () => {
  const AMOUNTS = [
    "0.0000001", // 1 stroop
    "0.0000003", // prime stroop total
    "0.0000007", // prime stroop total
    "0.0000011", // prime stroop total
    "0.1",
    "0.3",
    "1",
    "3",
    "10",
    "97", // prime
    "100",
    "1234.5678901",
    "922337203685.4775807", // Int64 max: the largest legal Stellar amount
  ];
  const COUNTS = [1, 2, 3, 4, 5, 6, 7, 12];

  it.each(AMOUNTS)("total %s always sums back to itself", (amount) => {
    const total = toStroops(amount);

    for (const count of COUNTS) {
      const shares = computeShares(amount, "equal", participants(count));

      // Acceptance: shares sum to exactly the original expense total.
      expect(stroopsOf(shares)).toBe(total);

      // Exact-integer distribution: floor for everyone but the first, and
      // the entire remainder parked on the first share.
      const base = total / BigInt(count);
      const remainder = total - base * BigInt(count);
      const stroops = shares.map((s) => toStroops(s.shareAmount));
      expect(stroops[0]).toBe(base + remainder);
      expect(stroops.slice(1)).toEqual(Array.from({ length: count - 1 }, () => base));

      // Results stay canonical decimals (7dp, no exponent notation).
      for (const share of shares) {
        expect(share.shareAmount).toMatch(CANONICAL_AMOUNT);
      }
    }
  });

  it.each([
    ["0.1", 3],
    ["0.3", 7],
    ["97.77", 4],
    ["1000000", 9],
  ])("percentage split of %s among %i participants conserves the total", (amount, count) => {
    // Even percentages that do not divide the total: every floor throws away
    // stroops that must resurface on the first share.
    const evenPercent = 100 / count;
    const shares = computeShares(
      amount,
      "percentage",
      Array.from({ length: count }, (_, i) => ({
        userId: `u${i + 1}`,
        percent: i === 0 ? 100 - evenPercent * (count - 1) : evenPercent,
      }))
    );

    expect(stroopsOf(shares)).toBe(toStroops(amount));
    for (const share of shares) {
      expect(share.shareAmount).toMatch(CANONICAL_AMOUNT);
    }
  });
});

describe("computeShares — percentage split rounding", () => {
  it("assigns exact percentage shares when they divide evenly", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 50 },
      { userId: "b", percent: 50 },
    ]);

    expect(shares.map((s) => s.shareAmount)).toEqual(["50", "50"]);
    expect(stroopsOf(shares)).toBe(toStroops("100"));
  });

  it("rounds fractional percentages without losing a stroop", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);

    expect(shares.map((s) => s.shareAmount)).toEqual(["33.33", "33.33", "33.34"]);
    expect(stroopsOf(shares)).toBe(toStroops("100"));
  });

  it("parks floor losses from fractional percentages on the first share", () => {
    // 7 stroops * 33.33% floors to 2 stroops, so all three shares floor to 2
    // and the lost stroop must reappear on the first share.
    const shares = computeShares("0.0000007", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);

    expect(shares.map((s) => toStroops(s.shareAmount))).toEqual([3n, 2n, 2n]);
    expect(stroopsOf(shares)).toBe(7n);
  });

  it("still conserves the total when tiny totals floor shares to zero", () => {
    // 3 stroops: 33.33% floors to 0, 33.34% floors to 1. The 2-stroop gap
    // that flooring leaves behind is parked on the first share.
    const shares = computeShares("0.0000003", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);

    expect(shares.map((s) => toStroops(s.shareAmount))).toEqual([2n, 0n, 1n]);
    expect(stroopsOf(shares)).toBe(3n);
  });

  it("splits a large total into exact integer shares", () => {
    const shares = computeShares("1000000000", "percentage", [
      { userId: "a", percent: 10 },
      { userId: "b", percent: 10 },
      { userId: "c", percent: 10 },
      { userId: "d", percent: 10 },
      { userId: "e", percent: 10 },
      { userId: "f", percent: 10 },
      { userId: "g", percent: 10 },
      { userId: "h", percent: 10 },
      { userId: "i", percent: 10 },
      { userId: "j", percent: 10 },
    ]);

    expect(shares.every((s) => s.shareAmount === "100000000")).toBe(true);
    expect(stroopsOf(shares)).toBe(toStroops("1000000000"));
  });
});

describe("computeShares — custom split rounding", () => {
  it("passes custom amounts through untouched (no re-rounding)", () => {
    const shares = computeShares("0.3", "custom", [
      { userId: "a", amount: "0.1" },
      { userId: "b", amount: "0.2" },
    ]);

    expect(shares.map((s) => s.shareAmount)).toEqual(["0.1", "0.2"]);
    expect(stroopsOf(shares)).toBe(toStroops("0.3"));
  });

  it("rejects custom shares that miss the total by a single stroop", () => {
    // 0.1 + 0.1999999 = 0.2999999 — one stroop short of 0.3.
    expect(() =>
      computeShares("0.3", "custom", [
        { userId: "a", amount: "0.1" },
        { userId: "b", amount: "0.1999999" },
      ])
    ).toThrow(/sum/);
  });

  it("verifies the custom sum in stroops, not in float", () => {
    // 0.1 + 0.2 is 0.30000000000000004 in float but exactly 0.3 in stroops.
    const shares = computeShares("0.3", "custom", [
      { userId: "a", amount: "0.1" },
      { userId: "b", amount: "0.2" },
    ]);

    expect(stroopsOf(shares)).toBe(3000000n);
    expect(shares.every((s) => CANONICAL_AMOUNT.test(s.shareAmount))).toBe(true);
  });

  it("accepts an uneven prime-shaped custom split that sums exactly", () => {
    const shares = computeShares("97", "custom", [
      { userId: "a", amount: "31.3333333" },
      { userId: "b", amount: "31.3333334" },
      { userId: "c", amount: "34.3333333" },
    ]);

    expect(stroopsOf(shares)).toBe(toStroops("97"));
  });
});

describe("computeShares — guard rails around the stroop range", () => {
  it("splits the maximum representable amount without overflow", () => {
    const shares = computeShares("922337203685.4775807", "equal", participants(3));

    expect(stroopsOf(shares)).toBe(MAX_STROOPS);
    for (const share of shares) {
      expect(toStroops(share.shareAmount)).toBeLessThanOrEqual(MAX_STROOPS);
    }
  });

  it("rejects a zero total", () => {
    expect(() => computeShares("0", "equal", participants(3))).toThrow(
      /greater than zero/
    );
  });

  it("rejects a negative total", () => {
    expect(() => computeShares("-1", "equal", participants(3))).toThrow(
      /greater than zero/
    );
  });

  it("rejects an empty participant list", () => {
    expect(() => computeShares("10", "equal", [])).toThrow(/At least one participant/);
  });
});
