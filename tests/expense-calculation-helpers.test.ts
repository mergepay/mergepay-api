import { describe, expect, it } from "vitest";
import {
  EXPENSE_CALCULATION_ERROR_CODES,
  accumulateExpensesByAsset,
  assertExpenseShape,
  buildAssetBreakdowns,
  buildParticipantAmounts,
  buildRateTable,
  calculateGroupExpenseBreakdown,
  normalizeToTargetAsset,
  parseExpenseShares,
  type ExpenseRecord,
} from "../src/services/expense-calculation";

const dinner: ExpenseRecord = {
  id: "e1",
  payerUserId: "alice",
  assetCode: "XLM",
  assetIssuer: null,
  amount: "30.0000000",
  shares: [
    { userId: "alice", shareAmount: "10" },
    { userId: "bob", shareAmount: "10" },
    { userId: "carol", shareAmount: "10" },
  ],
};

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe("expense calculation helpers (#1085)", () => {
  it("buildRateTable rejects duplicate and malformed rates", () => {
    const rate = { fromAssetCode: "USDC", fromAssetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", rate: "2" };
    expect(buildRateTable([rate]).size).toBe(1);
    expect(buildRateTable(undefined).size).toBe(0);
    expect(codeOf(() => buildRateTable([rate, rate]))).toBe(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_RATE
    );
  });

  it("assertExpenseShape rejects missing payer, empty shares and duplicate sharers", () => {
    expect(() => assertExpenseShape(dinner)).not.toThrow();
    expect(codeOf(() => assertExpenseShape({ ...dinner, payerUserId: " " }))).toBe(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS
    );
    expect(codeOf(() => assertExpenseShape({ ...dinner, shares: [] }))).toBe(
      EXPENSE_CALCULATION_ERROR_CODES.INVALID_PARTICIPANTS
    );
    expect(
      codeOf(() =>
        assertExpenseShape({
          ...dinner,
          shares: [dinner.shares[0], dinner.shares[0]],
        })
      )
    ).toBe(EXPENSE_CALCULATION_ERROR_CODES.DUPLICATE_PARTICIPANT);
  });

  it("parseExpenseShares returns stroops and checks the declared amount", () => {
    expect(parseExpenseShares(dinner)).toEqual([100000000n, 100000000n, 100000000n]);
    expect(codeOf(() => parseExpenseShares({ ...dinner, amount: "31" }))).toBe(
      EXPENSE_CALCULATION_ERROR_CODES.INCONSISTENT_EXPENSE
    );
  });

  it("accumulateExpensesByAsset groups paid/owed per asset in first-seen order", () => {
    const acc = accumulateExpensesByAsset([dinner]);
    const [only] = [...acc.values()];
    expect(only.order).toEqual(["alice", "bob", "carol"]);
    expect(only.paid.get("alice")).toBe(300000000n);
    expect(only.owed.get("bob")).toBe(100000000n);
    expect(only.expenseCount).toBe(1);
  });

  it("buildParticipantAmounts computes net = paid - owed", () => {
    const rows = buildParticipantAmounts(
      ["a", "b"],
      new Map([["a", 30000000n]]),
      new Map([["a", 10000000n], ["b", 20000000n]]),
      ""
    );
    expect(rows).toEqual([
      { userId: "a", paid: "3", owed: "1", net: "2" },
      { userId: "b", paid: "0", owed: "2", net: "-2" },
    ]);
  });

  it("buildAssetBreakdowns nets to zero per asset", () => {
    const [asset] = buildAssetBreakdowns(accumulateExpensesByAsset([dinner]));
    expect(asset.total).toBe("30");
    expect(asset.participants.map((p) => p.net)).toEqual([
      "20",
      "-10",
      "-10",
    ]);
  });

  it("normalizeToTargetAsset requires a rate for non-target assets", () => {
    const usdc: ExpenseRecord = { ...dinner, id: "e2", assetCode: "USDC", assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" };
    const acc = accumulateExpensesByAsset([dinner, usdc]);
    expect(codeOf(() => normalizeToTargetAsset(acc, buildRateTable([]), { assetCode: "XLM" }))).toBe(
      EXPENSE_CALCULATION_ERROR_CODES.MISSING_RATE
    );
  });

  it("the composed function matches the helpers", () => {
    const direct = calculateGroupExpenseBreakdown([dinner]);
    expect(direct.assets).toEqual(buildAssetBreakdowns(accumulateExpensesByAsset([dinner])));
    expect(direct.normalized).toBeUndefined();
  });
});
