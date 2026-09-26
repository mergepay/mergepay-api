import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Tests for the treasury-stellar service (issue #505): Horizon I/O and
 * envelope hashing for the treasury routes, isolated behind typed service
 * functions so the HTTP layer never touches the Stellar SDK.
 *
 * `../src/services/stellar` is fully mocked — this module's contract is that
 * it delegates to the stellar service and shapes the domain objects itself.
 */

const h = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  hashOf: vi.fn(),
}));

vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: h.loadAccount,
    hashOf: h.hashOf,
  },
}));

import {
  toTreasuryAccountView,
  getTreasuryAccount,
  getTreasuryMultisigRequirement,
  hashOfEnvelope,
  assertSignedXdrMatchesIntent,
} from "../src/services/treasury-stellar";
import { AppError, Errors } from "../src/errors";

const TREASURY_KEY = "GTREASURYACCOUNTKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function snapshot(over: Partial<Parameters<typeof toTreasuryAccountView>[1]> = {}) {
  return {
    exists: true,
    sequence: "100",
    balances: [
      { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
      {
        assetCode: "USDC",
        assetIssuer: "GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        balance: "25.5000000",
      },
    ],
    signers: [
      { key: "GSIGNERONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", weight: 1 },
      { key: "GSIGNERTWOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", weight: 1 },
    ],
    thresholds: { low: 0, med: 2, high: 2 },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toTreasuryAccountView", () => {
  it("maps an account snapshot into the treasury view shape", () => {
    const view = toTreasuryAccountView(TREASURY_KEY, snapshot());

    expect(view).toEqual({
      publicKey: TREASURY_KEY,
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
        {
          assetCode: "USDC",
          assetIssuer: "GISSUERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          balance: "25.5000000",
        },
      ],
      signers: expect.any(Array),
      thresholds: { low: 0, med: 2, high: 2 },
    });
    expect(view.signers).toHaveLength(2);
  });

  it("passes through empty defaults for an unfunded account", () => {
    const view = toTreasuryAccountView(TREASURY_KEY, {
      exists: false,
      sequence: "0",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });

    expect(view.balances).toEqual([]);
    expect(view.signers).toEqual([]);
    expect(view.thresholds).toEqual({ low: 0, med: 0, high: 0 });
  });
});

describe("getTreasuryAccount", () => {
  it("loads the account via the stellar service and returns the view", async () => {
    h.loadAccount.mockResolvedValueOnce(snapshot());

    const view = await getTreasuryAccount(TREASURY_KEY);

    expect(h.loadAccount).toHaveBeenCalledWith(TREASURY_KEY);
    expect(view.publicKey).toBe(TREASURY_KEY);
    expect(view.balances).toHaveLength(2);
  });

  it("propagates Horizon failures from the stellar service", async () => {
    h.loadAccount.mockRejectedValueOnce(new Error("Horizon unavailable"));

    await expect(getTreasuryAccount(TREASURY_KEY)).rejects.toThrow(
      "Horizon unavailable"
    );
  });
});

describe("getTreasuryMultisigRequirement", () => {
  it("returns the on-chain signer keys and the configured threshold", async () => {
    h.loadAccount.mockResolvedValueOnce(snapshot());

    const requirement = await getTreasuryMultisigRequirement(TREASURY_KEY, 2);

    expect(requirement).toEqual({
      signers: [
        "GSIGNERONEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "GSIGNERTWOAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      ],
      threshold: 2,
    });
  });

  it("throws treasury_unfunded when the account does not exist", async () => {
    h.loadAccount.mockResolvedValueOnce(
      snapshot({
        exists: false,
        balances: [],
        signers: [],
      })
    );

    await expect(getTreasuryMultisigRequirement(TREASURY_KEY, 2)).rejects.toMatchObject({
      code: "TREASURY_UNFUNDED",
      statusCode: 400,
    });
  });
});

describe("hashOfEnvelope", () => {
  it("delegates hashing to the stellar service", () => {
    h.hashOf.mockReturnValueOnce("abc123");

    expect(hashOfEnvelope("AAAA...xdr")).toBe("abc123");
    expect(h.hashOf).toHaveBeenCalledWith("AAAA...xdr");
  });
});

describe("assertSignedXdrMatchesIntent", () => {
  it("accepts an envelope whose hash matches the intended transaction", () => {
    h.hashOf.mockReturnValueOnce("intended_hash");

    expect(() =>
      assertSignedXdrMatchesIntent("signed-xdr", "intended_hash")
    ).not.toThrow();
  });

  it("throws xdr_mismatch when the envelope hashes differently", () => {
    h.hashOf.mockReturnValueOnce("different_hash");

    try {
      assertSignedXdrMatchesIntent("signed-xdr", "intended_hash");
      expect.unreachable("expected xdr_mismatch");
    } catch (e) {
      expect((e as { code: string }).code).toBe("XDR_MISMATCH");
      expect((e as { message: string }).message).toContain(
        "does not match the intended transaction"
      );
    }
  });

  it("throws xdr_malformed when the envelope cannot be parsed", () => {
    h.hashOf.mockImplementationOnce(() => {
      throw new Error("unexpected XDR");
    });

    try {
      assertSignedXdrMatchesIntent("garbage", "intended_hash");
      expect.unreachable("expected xdr_malformed");
    } catch (e) {
      expect((e as { code: string }).code).toBe("XDR_MALFORMED");
      expect((e as { message: string }).message).toContain("Could not parse signed XDR");
    }
  });

  it("lets an AppError from the underlying hash call pass through untouched", () => {
    const appError: AppError = Errors.badRequest("xdr_malformed", "already typed");
    h.hashOf.mockImplementationOnce(() => {
      throw appError;
    });

    expect(() => assertSignedXdrMatchesIntent("garbage", "intended_hash")).toThrow(
      appError
    );
  });
});
