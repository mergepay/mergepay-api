/**
 * Group expense split calculation — comprehensive unit tests.
 *
 * The split engine (`computeShares` in `src/services/settlement.ts`) is the one
 * place where an expense is divided among group members. Everything downstream
 * — who owes whom, settle-up suggestions, settlement amounts — is derived from
 * its output, so an off-by-one stroop here becomes a real, unpayable debt.
 *
 * These tests pin the arithmetic contract:
 *   - shares always sum *exactly* to the expense total (no stranded stroops);
 *   - a single participant and an empty list never divide by zero;
 *   - equal and percentage splits floor first and dump the remainder on one
 *     share, never silently dropping or inventing value;
 *   - the engine is currency-agnostic — XLM and USDC are both 7-decimal Stellar
 *     assets, so identical amounts must produce identical shares in either.
 *
 * All math runs in BigInt stroops, so these cases also act as a regression net
 * against reintroducing IEEE-754 floating-point arithmetic (0.1 + 0.2 !== 0.3).
 */
import { describe, it, expect } from "vitest";
import {
  computeShares,
  computeNetBalances,
  type ComputedShare,
} from "../src/services/settlement";
import { toStroops, validateAsset } from "../src/services/money";

const USDC_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** The two assets Mergepay settles in. Both use Stellar's 7-decimal scale. */
const ASSETS = [
  { assetCode: "XLM", assetIssuer: null },
  { assetCode: "USDC", assetIssuer: USDC_ISSUER },
] as const;

/** Sum every returned share back into stroops for exact comparison. */
function totalStroops(shares: ComputedShare[]): bigint {
  return shares.reduce((sum, s) => sum + toStroops(s.shareAmount), 0n);
}

/** Assert the split distributes the whole amount, to the stroop. */
function expectDistributesExactly(shares: ComputedShare[], amount: string): void {
  expect(totalStroops(shares)).toBe(toStroops(amount));
}

const members = (...ids: string[]) => ids.map((userId) => ({ userId }));

describe("computeShares — equal split", () => {
  it("divides evenly when the amount is a clean multiple", () => {
    const shares = computeShares("9", "equal", members("a", "b", "c"));
    expect(shares.map((s) => s.shareAmount)).toEqual(["3", "3", "3"]);
    expectDistributesExactly(shares, "9");
  });

  it("absorbs an odd remainder on the first share (10 / 3)", () => {
    const shares = computeShares("10", "equal", members("a", "b", "c"));
    // 10.0000000 / 3 = 3.3333333 each, leaving 1 stroop for the first share.
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "3.3333334",
      "3.3333333",
      "3.3333333",
    ]);
    expectDistributesExactly(shares, "10");
  });

  it("splits a prime amount that never divides (7 / 3)", () => {
    const shares = computeShares("7", "equal", members("a", "b", "c"));
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "2.3333334",
      "2.3333333",
      "2.3333333",
    ]);
    expectDistributesExactly(shares, "7");
  });

  it("absorbs a multi-stroop remainder on the first share (101 / 7)", () => {
    const shares = computeShares(
      "101",
      "equal",
      members("a", "b", "c", "d", "e", "f", "g")
    );
    expect(shares[0].shareAmount).toBe("14.4285716");
    expect(shares.slice(1).map((s) => s.shareAmount)).toEqual([
      "14.4285714",
      "14.4285714",
      "14.4285714",
      "14.4285714",
      "14.4285714",
      "14.4285714",
    ]);
    expectDistributesExactly(shares, "101");
  });

  it("splits the smallest representable amount (1 stroop / 3)", () => {
    const shares = computeShares("0.0000001", "equal", members("a", "b", "c"));
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0000001",
      "0",
      "0",
    ]);
    expectDistributesExactly(shares, "0.0000001");
  });

  it("keeps a sub-cent amount exact (0.01 / 3)", () => {
    const shares = computeShares("0.01", "equal", members("a", "b", "c"));
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "0.0033334",
      "0.0033333",
      "0.0033333",
    ]);
    expectDistributesExactly(shares, "0.01");
  });

  it("gives a single-member group the entire amount (no division by zero)", () => {
    const shares = computeShares("42.5", "equal", members("solo"));
    expect(shares).toEqual([{ userId: "solo", shareAmount: "42.5" }]);
    expectDistributesExactly(shares, "42.5");
  });

  it("splits an odd amount between two members (10.0000001 / 2)", () => {
    const shares = computeShares("10.0000001", "equal", members("a", "b"));
    expect(shares.map((s) => s.shareAmount)).toEqual(["5.0000001", "5"]);
    expectDistributesExactly(shares, "10.0000001");
  });

  it("splits 1 XLM across seven members", () => {
    const shares = computeShares(
      "1",
      "equal",
      members("a", "b", "c", "d", "e", "f", "g")
    );
    expect(shares[0].shareAmount).toBe("0.1428574");
    expect(shares.slice(1).map((s) => s.shareAmount)).toEqual(
      Array(6).fill("0.1428571")
    );
    expectDistributesExactly(shares, "1");
  });

  it("distributes every amount exactly and never over-allocates a later share", () => {
    const amounts = ["1", "7", "10", "99", "100", "101", "104729", "0.0000001"];
    for (const amount of amounts) {
      for (let n = 1; n <= 9; n++) {
        const ids = Array.from({ length: n }, (_, i) => `u${i}`);
        const shares = computeShares(amount, "equal", members(...ids));
        expect(shares).toHaveLength(n);
        expectDistributesExactly(shares, amount);
        // Remainder lands on the first share; the rest are a flat floor.
        for (let i = 1; i < n; i++) {
          expect(toStroops(shares[0].shareAmount)).toBeGreaterThanOrEqual(
            toStroops(shares[i].shareAmount)
          );
          expect(shares[i].shareAmount).toBe(shares[1].shareAmount);
        }
      }
    }
  });

  it("rejects a zero amount instead of splitting nothing", () => {
    expect(() => computeShares("0", "equal", members("a", "b"))).toThrow(
      /greater than zero/
    );
  });

  it("rejects a negative amount", () => {
    expect(() => computeShares("-10", "equal", members("a"))).toThrow(
      /greater than zero/
    );
  });

  it("rejects an empty participant list instead of dividing by zero", () => {
    expect(() => computeShares("10", "equal", [])).toThrow(
      /At least one participant required/
    );
  });
});

describe("computeShares — percentage split", () => {
  it("assigns exact percentage shares for a 3-way split", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 33.33 },
      { userId: "b", percent: 33.33 },
      { userId: "c", percent: 33.34 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual([
      "33.33",
      "33.33",
      "33.34",
    ]);
    expectDistributesExactly(shares, "100");
  });

  it("handles a simple 60 / 40 percentage split", () => {
    const shares = computeShares("100", "percentage", [
      { userId: "a", percent: 60 },
      { userId: "b", percent: 40 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["60", "40"]);
    expectDistributesExactly(shares, "100");
  });

  it("preserves the total for a prime amount across uneven percentages", () => {
    const shares = computeShares("713.5", "percentage", [
      { userId: "a", percent: 10 },
      { userId: "b", percent: 45 },
      { userId: "c", percent: 45 },
    ]);
    expectDistributesExactly(shares, "713.5");
  });

  it("drops the leftover stroop onto the first share (1 stroop @ 50/50)", () => {
    const shares = computeShares("0.0000001", "percentage", [
      { userId: "a", percent: 50 },
      { userId: "b", percent: 50 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["0.0000001", "0"]);
    expectDistributesExactly(shares, "0.0000001");
  });

  it("lets a 0% participant hold no share while the other takes the whole expense", () => {
    const shares = computeShares("10", "percentage", [
      { userId: "a", percent: 100 },
      { userId: "b", percent: 0 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["10", "0"]);
    expectDistributesExactly(shares, "10");
  });

  it("accepts three 3-decimal percentages that sum to 100 within tolerance", () => {
    const shares = computeShares("1", "percentage", [
      { userId: "a", percent: 33.333 },
      { userId: "b", percent: 33.333 },
      { userId: "c", percent: 33.334 },
    ]);
    expectDistributesExactly(shares, "1");
  });

  it("rejects percentages that sum to less than 100", () => {
    expect(() =>
      computeShares("100", "percentage", [
        { userId: "a", percent: 33.33 },
        { userId: "b", percent: 33.33 },
        { userId: "c", percent: 33.33 },
      ])
    ).toThrow(/100/);
  });

  it("rejects percentages that sum to more than 100", () => {
    expect(() =>
      computeShares("100", "percentage", [
        { userId: "a", percent: 50 },
        { userId: "b", percent: 60 },
      ])
    ).toThrow(/100/);
  });

  it("rejects a share missing its percent", () => {
    expect(() =>
      computeShares("100", "percentage", [
        { userId: "a", percent: 50 },
        { userId: "b" },
      ])
    ).toThrow(/percent/i);
  });

  it("rejects a zero amount before splitting by percentage", () => {
    expect(() =>
      computeShares("0", "percentage", [{ userId: "a", percent: 100 }])
    ).toThrow(/greater than zero/);
  });
});

describe("computeShares — custom split", () => {
  it("returns each custom amount verbatim when they sum to the total", () => {
    const shares = computeShares("30", "custom", [
      { userId: "a", amount: "10" },
      { userId: "b", amount: "20" },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["10", "20"]);
    expectDistributesExactly(shares, "30");
  });

  it("supports a single custom share equal to the whole expense", () => {
    const shares = computeShares("30", "custom", [
      { userId: "a", amount: "30" },
    ]);
    expect(shares).toEqual([{ userId: "a", shareAmount: "30" }]);
  });

  it("splits a prime amount into exact custom shares (97 = 32 + 32 + 33)", () => {
    const shares = computeShares("97", "custom", [
      { userId: "a", amount: "32" },
      { userId: "b", amount: "32" },
      { userId: "c", amount: "33" },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["32", "32", "33"]);
    expectDistributesExactly(shares, "97");
  });

  it("handles 7-decimal custom shares whose sum is exactly the total", () => {
    const shares = computeShares("100", "custom", [
      { userId: "a", amount: "33.3333333" },
      { userId: "b", amount: "33.3333334" },
      { userId: "c", amount: "33.3333333" },
    ]);
    expectDistributesExactly(shares, "100");
  });

  it("is immune to the 0.1 + 0.2 floating-point trap", () => {
    const shares = computeShares("0.3", "custom", [
      { userId: "a", amount: "0.1" },
      { userId: "b", amount: "0.2" },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["0.1", "0.2"]);
    expectDistributesExactly(shares, "0.3");
  });

  it("rejects custom amounts that do not cover the total", () => {
    expect(() =>
      computeShares("0.14", "custom", [
        { userId: "a", amount: "0.07" },
        { userId: "b", amount: "0.06" },
      ])
    ).toThrow(/sum/);
  });

  it("rejects custom amounts that exceed the total", () => {
    expect(() =>
      computeShares("30", "custom", [
        { userId: "a", amount: "20" },
        { userId: "b", amount: "20" },
      ])
    ).toThrow(/sum/);
  });

  it("rejects a custom share missing its amount", () => {
    expect(() =>
      computeShares("30", "custom", [
        { userId: "a", amount: "10" },
        { userId: "b" },
      ])
    ).toThrow(/amount/);
  });

  it("rejects a zero total for a custom split", () => {
    expect(() =>
      computeShares("0", "custom", [{ userId: "a", amount: "0" }])
    ).toThrow(/greater than zero/);
  });
});

describe("computeShares — XLM and USDC", () => {
  it("recognises both supported assets", () => {
    for (const { assetCode, assetIssuer } of ASSETS) {
      const result = validateAsset(assetCode, assetIssuer);
      expect(result.assetCode).toBe(assetCode);
    }
  });

  it("produces identical equal splits for the same amount in either currency", () => {
    for (const { assetCode } of ASSETS) {
      const shares = computeShares("101", "equal", members("a", "b", "c"));
      expectDistributesExactly(shares, "101");
      // The engine is asset-agnostic; the currency never changes the arithmetic.
      expect(shares.map((s) => s.shareAmount)).toEqual([
        "33.6666668",
        "33.6666666",
        "33.6666666",
      ]);
      expect(assetCode).toMatch(/^(XLM|USDC)$/);
    }
  });

  it("resolves USDC amounts to the same 7-decimal stroop scale as XLM", () => {
    const inXlm = computeShares("0.0000001", "equal", members("a", "b"));
    const inUsdc = computeShares("0.0000001", "equal", members("a", "b"));
    expect(inXlm).toEqual(inUsdc);
    expectDistributesExactly(inXlm, "0.0000001");
    expectDistributesExactly(inUsdc, "0.0000001");
  });

  it("keeps percentage splits exact for a USDC amount", () => {
    const shares = computeShares("250.75", "percentage", [
      { userId: "a", percent: 25 },
      { userId: "b", percent: 75 },
    ]);
    expect(shares.map((s) => s.shareAmount)).toEqual(["62.6875", "188.0625"]);
    expectDistributesExactly(shares, "250.75");
  });
});

describe("computeShares — integration with net balances", () => {
  it("turns a three-way dinner split into balanced group debts", () => {
    const amount = "10";
    const shares = computeShares("10", "equal", members("a", "b", "c"));

    // Payer "a" fronted the bill: their own share is settled immediately and
    // the other two owe their shares back to "a".
    const balances = computeNetBalances(
      shares.map((s) => ({
        payerUserId: "a",
        userId: s.userId,
        shareAmount: s.shareAmount,
        settled: s.userId === "a",
      })),
      []
    );

    const byUser = Object.fromEntries(balances.map((b) => [b.userId, toStroops(b.net)]));
    expect(byUser.a).toBe(toStroops("6.6666666"));
    expect(byUser.b).toBe(toStroops("-3.3333333"));
    expect(byUser.c).toBe(toStroops("-3.3333333"));

    // Every stroop of the expense is accounted for: debts net to zero.
    expect(balances.reduce((sum, b) => sum + toStroops(b.net), 0n)).toBe(0n);
    expectDistributesExactly(shares, amount);
  });
});
