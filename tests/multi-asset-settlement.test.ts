/**
 * Multi-asset settlement balances.
 *
 * A group can hold expenses in more than one Stellar asset — XLM and USDC are
 * both 7-decimal assets, but a stroop of one is worth nothing in the other.
 * These tests pin the contract that the settlement engine nets balances *per
 * asset*: an XLM debt can never be cancelled by a USDC credit, and each asset's
 * debts still resolve to exactly zero.
 *
 * All amounts flow through the shared BigInt stroop math, so the cases also act
 * as a regression net against floating-point drift across currencies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertSupportedSettlementAsset,
  balanceAssetKey,
  computeNetBalancesByAsset,
  computeShares,
  suggestSettlements,
  type AssetBalanceShareRow,
  type AssetBalanceSettlementRow,
} from "../src/services/settlement";
import { toStroops } from "../src/services/money";

const USDC_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const OTHER_ISSUER =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

const XLM = { assetCode: "XLM", assetIssuer: null } as const;
const USDC = { assetCode: "USDC", assetIssuer: USDC_ISSUER } as const;

/** Total of every participant's net, per asset — must be exactly zero. */
function netSum(balances: { userId: string; net: string }[]): bigint {
  return balances.reduce((sum, b) => sum + toStroops(b.net), 0n);
}

function byUser(balances: { userId: string; net: string }[]) {
  return Object.fromEntries(balances.map((b) => [b.userId, b.net]));
}

const expenseShare = (
  payerUserId: string,
  userId: string,
  shareAmount: string,
  settled: boolean,
  asset: { assetCode: string; assetIssuer: string | null }
): AssetBalanceShareRow => ({ payerUserId, userId, shareAmount, settled, ...asset });

const settlement = (
  fromUserId: string,
  toUserId: string,
  amount: string,
  confirmed: boolean,
  asset: { assetCode: string; assetIssuer: string | null }
): AssetBalanceSettlementRow => ({
  fromUserId,
  toUserId,
  amount,
  confirmed,
  ...asset,
});

describe("balanceAssetKey", () => {
  it("upper-cases the code but keeps the issuer distinct", () => {
    expect(balanceAssetKey("xlm", null)).toBe("XLM::");
    expect(balanceAssetKey("XLM", null)).toBe("XLM::");
    expect(balanceAssetKey("usdc", USDC_ISSUER)).toBe(`USDC::${USDC_ISSUER}`);
  });

  it("keeps two assets with the same code but different issuers apart", () => {
    expect(balanceAssetKey("USDC", USDC_ISSUER)).not.toBe(
      balanceAssetKey("USDC", OTHER_ISSUER)
    );
  });
});

describe("assertSupportedSettlementAsset", () => {
  it("accepts native XLM and the configured stablecoin", () => {
    expect(() => assertSupportedSettlementAsset("XLM", null)).not.toThrow();
    expect(() =>
      assertSupportedSettlementAsset("USDC", USDC_ISSUER)
    ).not.toThrow();
    // Case-insensitive code, default issuer when omitted.
    expect(() => assertSupportedSettlementAsset("usdc", null)).not.toThrow();
  });

  it("rejects an unsupported asset code", () => {
    expect(() => assertSupportedSettlementAsset("BTC", null)).toThrow(
      /Unsupported settlement asset/
    );
  });

  it("rejects USDC from an issuer that is not the configured one", () => {
    expect(() =>
      assertSupportedSettlementAsset("USDC", OTHER_ISSUER)
    ).toThrow(/Unsupported settlement asset/);
  });

  it("rejects an issuer attached to native XLM", () => {
    expect(() =>
      assertSupportedSettlementAsset("XLM", USDC_ISSUER)
    ).toThrow(/Unsupported settlement asset/);
  });
});

describe("computeNetBalancesByAsset", () => {
  it("segregates balances into one group per asset", () => {
    const result = computeNetBalancesByAsset(
      [
        expenseShare("alice", "bob", "10", false, XLM),
        expenseShare("alice", "carol", "25", false, USDC),
      ],
      []
    );

    expect(result).toHaveLength(2);
    const xlm = result.find((r) => r.assetCode === "XLM")!;
    const usdc = result.find((r) => r.assetCode === "USDC")!;

    expect(byUser(xlm.balances)).toEqual({ alice: "10", bob: "-10" });
    expect(byUser(usdc.balances)).toEqual({ alice: "25", carol: "-25" });
  });

  it("never lets one asset's credit cancel another's debt", () => {
    // Alice owes 10 XLM, but is owed 100 USDC. A naive combined engine would
    // report Alice net positive; per-asset she still owes the XLM.
    const result = computeNetBalancesByAsset(
      [
        expenseShare("bob", "alice", "10", false, XLM),
        expenseShare("alice", "carol", "100", false, USDC),
      ],
      []
    );

    const xlm = byUser(result.find((r) => r.assetCode === "XLM")!.balances);
    const usdc = byUser(result.find((r) => r.assetCode === "USDC")!.balances);
    expect(xlm.alice).toBe("-10");
    expect(usdc.alice).toBe("100");
  });

  it("keeps each asset's debts netting to exactly zero", () => {
    const result = computeNetBalancesByAsset(
      [
        expenseShare("alice", "bob", "3.3333333", false, XLM),
        expenseShare("alice", "carol", "6.6666667", false, XLM),
        expenseShare("bob", "alice", "0.0000001", false, USDC),
        expenseShare("bob", "carol", "99.5", false, USDC),
      ],
      []
    );

    for (const group of result) {
      expect(netSum(group.balances)).toBe(0n);
    }
  });

  it("only applies a confirmed settlement to its own asset", () => {
    const result = computeNetBalancesByAsset(
      [
        expenseShare("alice", "bob", "10", false, XLM),
        expenseShare("alice", "bob", "10", false, USDC),
      ],
      // Bob pays Alice 10 XLM; the USDC debt must remain untouched.
      [settlement("bob", "alice", "10", true, XLM)]
    );

    const xlm = byUser(result.find((r) => r.assetCode === "XLM")!.balances);
    const usdc = byUser(result.find((r) => r.assetCode === "USDC")!.balances);
    expect(xlm).toEqual({ alice: "0", bob: "0" });
    // Zero-net entries are dropped, so both participants are still present with
    // the XLM group only if non-zero... assert the USDC debt is intact.
    expect(usdc.bob).toBe("-10");
    expect(usdc.alice).toBe("10");
  });

  it("ignores unconfirmed settlements for the matching asset", () => {
    const result = computeNetBalancesByAsset(
      [expenseShare("alice", "bob", "10", false, USDC)],
      [settlement("bob", "alice", "10", false, USDC)]
    );
    expect(byUser(result[0].balances).bob).toBe("-10");
  });

  it("drops an asset group whose debts are fully settled", () => {
    const result = computeNetBalancesByAsset(
      [expenseShare("alice", "bob", "5", true, XLM)],
      []
    );
    expect(result).toHaveLength(0);
  });

  it("groups by issuer, not just code, and validates each asset", () => {
    // A USDC share from an unknown issuer is rejected rather than silently
    // merged with the configured USDC.
    expect(() =>
      computeNetBalancesByAsset(
        [expenseShare("alice", "bob", "10", false, { assetCode: "USDC", assetIssuer: OTHER_ISSUER })],
        []
      )
    ).toThrow(/Unsupported settlement asset/);
  });

  it("handles a complex multi-member, multi-asset distribution", () => {
    const shares: AssetBalanceShareRow[] = [
      // Alice fronts a 30 XLM dinner split equally between alice, bob, carol.
      ...computeShares("30", "equal", [
        { userId: "alice" },
        { userId: "bob" },
        { userId: "carol" },
      ]).map((s) => expenseShare("alice", s.userId, s.shareAmount, s.userId === "alice", XLM)),
      // Bob fronts a 100 USDC cab split 25/25/50 between alice, bob, carol.
      ...computeShares("100", "percentage", [
        { userId: "alice", percent: 25 },
        { userId: "bob", percent: 25 },
        { userId: "carol", percent: 50 },
      ]).map((s) => expenseShare("bob", s.userId, s.shareAmount, s.userId === "bob", USDC)),
    ];

    const result = computeNetBalancesByAsset(shares, []);
    const xlm = byUser(result.find((r) => r.assetCode === "XLM")!.balances);
    const usdc = byUser(result.find((r) => r.assetCode === "USDC")!.balances);

    // XLM: alice fronted 30, so is owed bob + carol's 10 each.
    expect(xlm.alice).toBe("20");
    expect(xlm.bob).toBe("-10");
    expect(xlm.carol).toBe("-10");

    // USDC: bob fronted 100; alice owes 25, carol owes 50, bob's own 25 settled.
    expect(usdc.bob).toBe("75");
    expect(usdc.alice).toBe("-25");
    expect(usdc.carol).toBe("-50");

    expect(netSum(result.find((r) => r.assetCode === "XLM")!.balances)).toBe(0n);
    expect(netSum(result.find((r) => r.assetCode === "USDC")!.balances)).toBe(0n);
  });
});

describe("per-asset settle-up suggestions", () => {
  it("produces transfers that zero each asset independently", () => {
    const result = computeNetBalancesByAsset(
      [
        expenseShare("alice", "bob", "10", false, XLM),
        expenseShare("carol", "bob", "20", false, USDC),
      ],
      []
    );

    for (const group of result) {
      const suggestions = suggestSettlements(group.balances);
      expect(suggestions.length).toBeGreaterThan(0);
      // Every suggested transfer is denominated in the group's own asset and
      // applied as a confirmed settlement cancels the original balance.
      const applied = computeNetBalancesByAsset(
        [],
        suggestions.map((s) =>
          settlement(s.fromUserId, s.toUserId, s.amount, true, {
            assetCode: group.assetCode,
            assetIssuer: group.assetIssuer,
          })
        )
      );
      for (const b of applied[0]?.balances ?? []) {
        const original =
          group.balances.find((o) => o.userId === b.userId)?.net ?? "0";
        expect(toStroops(original) + toStroops(b.net)).toBe(0n);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Service-level loading (mocked Prisma)
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const prisma = {
    expense: { findMany: vi.fn(), findFirst: vi.fn() },
    settlement: { findMany: vi.fn() },
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  loadGroupBalances,
  loadGroupBalancesByAsset,
} from "../src/services/group-balances";

const prisma = h.prisma as any;

const decimal = (value: string) => ({ toString: () => value });

describe("loadGroupBalancesByAsset", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.expense.findMany.mockResolvedValue([
      {
        payerUserId: "alice",
        assetCode: "XLM",
        assetIssuer: null,
        shares: [
          { userId: "alice", shareAmount: decimal("30"), status: "settled" },
          { userId: "bob", shareAmount: decimal("30"), status: "pending" },
        ],
      },
      {
        payerUserId: "alice",
        assetCode: "USDC",
        assetIssuer: USDC_ISSUER,
        shares: [
          { userId: "alice", shareAmount: decimal("10"), status: "settled" },
          { userId: "carol", shareAmount: decimal("10"), status: "pending" },
        ],
      },
    ]);
    prisma.settlement.findMany.mockResolvedValue([]);
    prisma.expense.findFirst.mockResolvedValue({
      assetCode: "USDC",
      assetIssuer: USDC_ISSUER,
    });
  });

  it("returns a separate balance sheet per asset", async () => {
    const result = await loadGroupBalancesByAsset("group_1");
    expect(result).toHaveLength(2);
    expect(byUser(result.find((r) => r.assetCode === "XLM")!.balances)).toEqual({
      alice: "30",
      bob: "-30",
    });
    expect(byUser(result.find((r) => r.assetCode === "USDC")!.balances)).toEqual({
      alice: "10",
      carol: "-10",
    });
  });

  it("scopes loadGroupBalances to the group's primary asset", async () => {
    const balances = await loadGroupBalances("group_1");
    expect(byUser(balances)).toEqual({ alice: "10", carol: "-10" });
  });

  it("rejects an expense stored with an unsupported asset", async () => {
    prisma.expense.findMany.mockResolvedValue([
      {
        payerUserId: "alice",
        assetCode: "DOGE",
        assetIssuer: null,
        shares: [
          { userId: "alice", shareAmount: decimal("1"), status: "settled" },
          { userId: "bob", shareAmount: decimal("1"), status: "pending" },
        ],
      },
    ]);
    await expect(loadGroupBalancesByAsset("group_1")).rejects.toThrow(
      /Unsupported settlement asset/
    );
  });
});
