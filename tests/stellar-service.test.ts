import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadResponseError, Keypair, NotFoundError, TransactionBuilder } from "@stellar/stellar-sdk";

// Fake Horizon behind the real stellar service: only the shared client
// accessor is replaced, so the service's own error handling is exercised.
const h = vi.hoisted(() => {
  const call = vi.fn();
  return {
    call,
    fake: {
      loadAccount: vi.fn(),
      submitTransaction: vi.fn(),
      feeStats: vi.fn(),
      transactions: vi.fn(() => ({ transaction: vi.fn(() => ({ call })) })),
    },
  };
});

vi.mock("../src/services/horizon", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/horizon")>();
  return { ...actual, horizonServer: () => h.fake };
});

import { stellar } from "../src/services/stellar";
import { getFeeStats, clearFeeStatsCache } from "../src/services/network";
import { TransportError } from "../src/services/timeout";
import { config } from "../src/config";

const source = Keypair.random();
const destination = Keypair.random().publicKey();

function signedXdr(): string {
  const xdr = stellar.buildPayment({
    sourcePublicKey: source.publicKey(),
    sourceSequence: "1",
    destination,
    asset: { code: "XLM" },
    amount: "1.0000000",
    memoCode: "abc",
  });
  const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase) as any;
  tx.sign(source);
  return tx.toXDR();
}

function horizonRejection(resultCodes: unknown): BadResponseError {
  return new BadResponseError("Transaction submission failed", {
    status: 400,
    data: { extras: { result_codes: resultCodes } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearFeeStatsCache();
});

describe("stellar.loadAccount", () => {
  it("maps a Horizon account into a snapshot", async () => {
    h.fake.loadAccount.mockResolvedValue({
      sequenceNumber: () => "42",
      balances: [
        { asset_type: "native", balance: "10.0000000" },
        { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GISSUER", balance: "5.0000000" },
      ],
      signers: [{ key: source.publicKey(), weight: 1 }],
      thresholds: { low_threshold: 0, med_threshold: 1, high_threshold: 2 },
    });

    const snapshot = await stellar.loadAccount(source.publicKey());

    expect(snapshot).toEqual({
      exists: true,
      sequence: "42",
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: "10.0000000" },
        { assetCode: "USDC", assetIssuer: "GISSUER", balance: "5.0000000" },
      ],
      signers: [{ key: source.publicKey(), weight: 1 }],
      thresholds: { low: 0, med: 1, high: 2 },
    });
  });

  it("reports an unfunded account (Horizon 404) as exists=false", async () => {
    h.fake.loadAccount.mockRejectedValue(new NotFoundError("Not Found", { status: 404 }));

    const snapshot = await stellar.loadAccount(source.publicKey());

    expect(snapshot.exists).toBe(false);
    expect(snapshot.balances).toEqual([]);
  });

  it("surfaces a genuine transport failure as a TransportError", async () => {
    h.fake.loadAccount.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(stellar.loadAccount(source.publicKey())).rejects.toBeInstanceOf(TransportError);
  });
});

describe("stellar.getTransaction", () => {
  it("returns the success flag of a visible transaction", async () => {
    h.call.mockResolvedValue({ successful: true });
    await expect(stellar.getTransaction("abc")).resolves.toEqual({ successful: true });
  });

  it("returns null while the transaction is not yet visible (404)", async () => {
    h.call.mockRejectedValue(new NotFoundError("Not Found", { status: 404 }));
    await expect(stellar.getTransaction("abc")).resolves.toBeNull();
  });

  it("rethrows other Horizon failures", async () => {
    h.call.mockRejectedValue(new Error("socket hang up"));
    await expect(stellar.getTransaction("abc")).rejects.toBeInstanceOf(TransportError);
  });
});

describe("stellar.submitSigned", () => {
  it("returns the hash Horizon reports", async () => {
    h.fake.submitTransaction.mockResolvedValue({ hash: "deadbeef" });
    await expect(stellar.submitSigned(signedXdr())).resolves.toBe("deadbeef");
  });

  it("turns a Horizon rejection into an upstream error carrying the result codes", async () => {
    h.fake.submitTransaction.mockRejectedValue(
      horizonRejection({ transaction: "tx_bad_seq" })
    );

    await expect(stellar.submitSigned(signedXdr())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
      message: expect.stringContaining("tx_bad_seq"),
    });
  });

  it("turns an unexpected transport failure into an upstream error", async () => {
    h.fake.submitTransaction.mockRejectedValue(new Error("ECONNRESET"));

    await expect(stellar.submitSigned(signedXdr())).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });
});

describe("stellar.submitMultisigPayment", () => {
  const expected = {
    sourcePublicKey: source.publicKey(),
    destination,
    asset: { code: "XLM" },
    amount: "1.0000000",
    memoCode: "abc",
  };
  const requirement = { signers: [source.publicKey()], threshold: 1 };

  it("classifies a Horizon rejection as upstream, not transport", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.fake.submitTransaction.mockRejectedValue(
      horizonRejection({ transaction: "tx_failed" })
    );

    await expect(
      stellar.submitMultisigPayment(signedXdr(), expected, requirement)
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
  });

  it("keeps transport failures retryable", async () => {
    h.fake.submitTransaction.mockRejectedValue(new Error("ECONNRESET"));

    await expect(
      stellar.submitMultisigPayment(signedXdr(), expected, requirement)
    ).rejects.toBeInstanceOf(TransportError);
  });

  it("never reaches Horizon for an envelope signed by an unknown key", async () => {
    await expect(
      stellar.submitMultisigPayment(signedXdr(), expected, {
        signers: [Keypair.random().publicKey()],
        threshold: 1,
      })
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(h.fake.submitTransaction).not.toHaveBeenCalled();
  });
});

describe("network.getFeeStats", () => {
  it("normalizes Horizon fee stats through the shared client", async () => {
    h.fake.feeStats.mockResolvedValue({
      min_accepted_fee: "100",
      mode_accepted_fee: "200",
      p50: "150",
      p99: "not-a-number",
    });

    const stats = await getFeeStats();

    expect(stats.minAcceptedFee).toBe(100);
    expect(stats.modeAcceptedFee).toBe(200);
    expect(stats.p50).toBe(150);
    expect(stats.p99).toBe(0);
  });
});
