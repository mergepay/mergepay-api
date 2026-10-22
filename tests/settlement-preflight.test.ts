/**
 * Settlement preflight (issue #194).
 *
 * The cases that matter are the ones where a naive check would pass an account
 * that cannot actually pay: XLM spent down into the base reserve, a USDC
 * balance mistaken for spendable XLM, and a trustline that does not exist at
 * all. Each has its own outcome so the API can say something actionable.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BASE_FEE } from "@stellar/stellar-sdk";
import {
  BASE_RESERVE_STROOPS,
  SETTLEMENT_FEE_STROOPS,
  checkSettlementPreflight,
  evaluatePreflight,
  assertPreflightResult,
  minimumBalanceStroops,
  nativeBalanceStroops,
  spendableXlmStroops,
} from "../src/services/settlement-preflight";
import type { AccountSnapshot } from "../src/services/stellar";
import { stellar } from "../src/services/stellar";
import { AppError } from "../src/errors";

const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** Horizon renders every balance at exactly 7 decimal places. */
function horizonAmount(xlm: string): string {
  const [whole, fraction = ""] = xlm.split(".");
  return `${whole}.${fraction.padEnd(7, "0")}`;
}

function account(overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return {
    exists: true,
    sequence: "1",
    balances: [
      { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("100") },
    ],
    signers: [{ key: "GSOURCE", weight: 1 }],
    thresholds: { low: 0, med: 0, high: 0 },
    ...overrides,
  };
}

const nativePayment = {
  sourcePublicKey: "GSOURCE",
  assetCode: "XLM",
  assetIssuer: null,
  amount: "10",
};

const usdcPayment = {
  sourcePublicKey: "GSOURCE",
  assetCode: "USDC",
  assetIssuer: ISSUER,
  amount: "10",
};

describe("reserve and spendable math", () => {
  it("reserves 1 XLM for a bare account (2 base subentries)", () => {
    expect(minimumBalanceStroops(account())).toBe(2n * BASE_RESERVE_STROOPS);
  });

  it("counts each trustline as an additional subentry", () => {
    const withTrustline = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("100") },
        { assetCode: "USDC", assetIssuer: ISSUER, balance: horizonAmount("50") },
      ],
    });
    expect(minimumBalanceStroops(withTrustline)).toBe(3n * BASE_RESERVE_STROOPS);
  });

  it("counts extra signers as subentries but not the master key", () => {
    const multisig = account({
      signers: [
        { key: "GSOURCE", weight: 1 },
        { key: "GCOSIGNER", weight: 1 },
      ],
    });
    expect(minimumBalanceStroops(multisig)).toBe(3n * BASE_RESERVE_STROOPS);
  });

  it("parses Horizon's fixed 7-decimal balances without losing precision", () => {
    const acct = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: "12.3456789" },
      ],
    });
    expect(nativeBalanceStroops(acct)).toBe(123_456_789n);
  });

  it("reports zero spendable — never negative — below the reserve", () => {
    const drained = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("0.5") },
      ],
    });
    expect(spendableXlmStroops(drained)).toBe(0n);
  });

  it("uses the fee the built envelope actually carries", () => {
    expect(SETTLEMENT_FEE_STROOPS).toBe(BigInt(Number(BASE_FEE) * 2));
  });
});

describe("native XLM settlements", () => {
  it("passes when the balance covers amount, fee, and reserve", () => {
    const result = evaluatePreflight(account(), nativePayment);
    expect(result.ok).toBe(true);
  });

  it("rejects an amount that would eat into the base reserve", () => {
    // 10 XLM held, 1 XLM reserved, so 9 spendable — 9.5 does not fit.
    const acct = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("10") },
      ],
    });
    const result = evaluatePreflight(acct, { ...nativePayment, amount: "9.5" });
    expect(result).toMatchObject({ ok: false, reason: "insufficient_asset_balance" });
  });

  it("rejects an amount that fits the reserve but leaves nothing for the fee", () => {
    // Exactly amount + reserve, one stroop short of also covering the fee.
    const acct = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("11") },
      ],
    });
    const result = evaluatePreflight(acct, { ...nativePayment, amount: "10" });
    expect(result).toMatchObject({ ok: false, reason: "insufficient_asset_balance" });
  });

  it("accepts an amount exactly equal to amount + fee + reserve", () => {
    const acct = account({
      balances: [
        {
          assetCode: "XLM",
          assetIssuer: null,
          // 10 XLM payment + 1 XLM reserve + the envelope fee, to the stroop.
          balance: horizonAmount("11.0000200"),
        },
      ],
    });
    const result = evaluatePreflight(acct, { ...nativePayment, amount: "10" });
    expect(result.ok).toBe(true);
  });

  it("never treats a USDC balance as spendable XLM", () => {
    // Rich in USDC, no XLM at all: an XLM payment must still be refused.
    const acct = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("0") },
        { assetCode: "USDC", assetIssuer: ISSUER, balance: horizonAmount("10000") },
      ],
    });
    const result = evaluatePreflight(acct, nativePayment);
    expect(result).toMatchObject({ ok: false, reason: "insufficient_asset_balance" });
  });
});

describe("USDC settlements", () => {
  function withUsdc(usdc: string, xlm: string): AccountSnapshot {
    return account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount(xlm) },
        { assetCode: "USDC", assetIssuer: ISSUER, balance: horizonAmount(usdc) },
      ],
    });
  }

  it("passes with a trustline, asset balance, and XLM for the fee", () => {
    const result = evaluatePreflight(withUsdc("50", "5"), usdcPayment);
    expect(result.ok).toBe(true);
  });

  it("reports a missing trustline distinctly from a zero balance", () => {
    const result = evaluatePreflight(account(), usdcPayment);
    expect(result).toMatchObject({ ok: false, reason: "missing_trustline" });
  });

  it("treats a zero-balance trustline as insufficient, not missing", () => {
    const result = evaluatePreflight(withUsdc("0", "5"), usdcPayment);
    expect(result).toMatchObject({
      ok: false,
      reason: "insufficient_asset_balance",
    });
  });

  it("rejects a same-code balance from a different issuer as no trustline", () => {
    const impostor = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("5") },
        {
          assetCode: "USDC",
          assetIssuer: "GDIFFERENTISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          balance: horizonAmount("999"),
        },
      ],
    });
    const result = evaluatePreflight(impostor, usdcPayment);
    expect(result).toMatchObject({ ok: false, reason: "missing_trustline" });
  });

  it("checks XLM fee capacity separately from the asset balance", () => {
    // Plenty of USDC, but the XLM balance is entirely consumed by the reserve
    // (1.5 XLM reserved for two base subentries plus the USDC trustline).
    const result = evaluatePreflight(withUsdc("500", "1.5"), usdcPayment);
    expect(result).toMatchObject({
      ok: false,
      reason: "insufficient_fee_balance",
    });
  });

  it("reports the asset shortfall first when both asset and fee are short", () => {
    const result = evaluatePreflight(withUsdc("1", "1.5"), usdcPayment);
    expect(result).toMatchObject({
      ok: false,
      reason: "insufficient_asset_balance",
    });
  });
});

describe("missing accounts and upstream failures", () => {
  const missing = account({ exists: false, balances: [], signers: [] });

  it("reports an unfunded account distinctly", () => {
    expect(evaluatePreflight(missing, nativePayment)).toMatchObject({
      ok: false,
      reason: "account_not_found",
    });
  });

  it("reports a Horizon outage as upstream, not as insufficient funds", async () => {
    const spy = vi
      .spyOn(stellar, "loadAccount")
      .mockRejectedValue(new Error("connect ECONNREFUSED"));
    try {
      const result = await checkSettlementPreflight(nativePayment);
      expect(result).toMatchObject({ ok: false, reason: "upstream_unavailable" });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not mutate the ledger — it only reads the account", async () => {
    const load = vi.spyOn(stellar, "loadAccount").mockResolvedValue(account());
    const submit = vi.spyOn(stellar, "submitPayment");
    try {
      await checkSettlementPreflight(nativePayment);
      expect(load).toHaveBeenCalledTimes(1);
      expect(submit).not.toHaveBeenCalled();
    } finally {
      load.mockRestore();
      submit.mockRestore();
    }
  });
});

describe("error mapping", () => {
  it("returns the passing result unchanged", () => {
    const ok = assertPreflightResult(evaluatePreflight(account(), nativePayment));
    expect(ok.ok).toBe(true);
  });

  it.each([
    ["account_not_found", account({ exists: false }), nativePayment, 400, "ACCOUNT_UNFUNDED"],
    ["missing_trustline", account(), usdcPayment, 400, "MISSING_TRUSTLINE"],
  ] as const)(
    "maps %s to a distinct client error",
    (_reason, acct, params, status, code) => {
      try {
        assertPreflightResult(evaluatePreflight(acct, params));
        expect.unreachable("preflight should have thrown");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).status).toBe(status);
        expect((error as AppError).code).toBe(code);
      }
    }
  );

  it("maps an upstream outage to 502, not a client error", () => {
    try {
      assertPreflightResult({
        ok: false,
        reason: "upstream_unavailable",
        message: "unreachable",
      });
      expect.unreachable("preflight should have thrown");
    } catch (error) {
      expect((error as AppError).status).toBe(502);
    }
  });

  it("never puts a balance figure in a client-visible message", () => {
    const acct = account({
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: horizonAmount("3.7") },
      ],
    });
    const result = evaluatePreflight(acct, { ...nativePayment, amount: "100" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("3.7");
      expect(result.message).not.toMatch(/\d+\.\d{7}/);
    }
  });
});
