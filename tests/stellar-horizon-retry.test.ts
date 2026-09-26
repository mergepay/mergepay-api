/**
 * Issue #536 — retry behaviour of the Horizon calls in src/services/stellar.ts.
 *
 * Drives the real service against a fake Horizon server and counts upstream
 * calls:
 *  - reads (loadAccount, getTransaction) recover from network errors,
 *    timeouts, 408, 429, and retryable 5xx within the bounded budget;
 *  - reads fail fast on 4xx and on 501/505;
 *  - 429 retry can be switched off with HORIZON_RETRY_ON_RATE_LIMIT=false;
 *  - submissions (submitPayment, submitSigned) reach Horizon exactly once,
 *    whatever the failure — a repeated submission is not a safe retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  Asset,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const loadAccount = vi.fn();
  const transactionCall = vi.fn();
  const submitTransaction = vi.fn();
  class FakeServer {
    loadAccount = loadAccount;
    submitTransaction = submitTransaction;
    transactions() {
      return { transaction: () => ({ call: transactionCall }) };
    }
  }
  return { loadAccount, transactionCall, submitTransaction, FakeServer };
});

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk"
  );
  return { ...actual, Horizon: { ...actual.Horizon, Server: h.FakeServer } };
});

import { config } from "../src/config";
import { stellar } from "../src/services/stellar";

/** Horizon SDK-shaped failure (`response` is the problem body, as the SDK sets it). */
function horizonError(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { response: { status, data: { status } } });
}
/** The SDK's shape for a connection failure: a bare Error, no response. */
function networkError() {
  return new Error("socket hang up");
}

const account = {
  sequenceNumber: () => "12345",
  balances: [{ asset_type: "native", balance: "100.0" }],
  signers: [{ key: "GA...", weight: 1 }],
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
};

const saved: Record<string, unknown> = {};
function setConfig(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = (config as any)[key];
    (config as any)[key] = value;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Fast, deterministic-enough schedule; 3 attempts.
  setConfig({
    UPSTREAM_RETRY_MAX_ATTEMPTS: 3,
    UPSTREAM_RETRY_INITIAL_DELAY_MS: 1,
    UPSTREAM_RETRY_MAX_DELAY_MS: 5,
    HORIZON_RETRY_ON_RATE_LIMIT: true,
  });
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) (config as any)[key] = value;
  for (const key of Object.keys(saved)) delete saved[key];
  vi.restoreAllMocks();
});

describe("loadAccount — transient failures are retried", () => {
  it.each([
    ["a network error", networkError],
    ["HTTP 429", () => horizonError(429)],
    ["HTTP 408", () => horizonError(408)],
    ["HTTP 500", () => horizonError(500)],
    ["HTTP 502", () => horizonError(502)],
    ["HTTP 503", () => horizonError(503)],
    ["HTTP 504", () => horizonError(504)],
  ])("recovers from %s", async (_label, make) => {
    h.loadAccount.mockRejectedValueOnce(make()).mockResolvedValue(account);

    const snapshot = await stellar.loadAccount("GABC");

    expect(snapshot.exists).toBe(true);
    expect(h.loadAccount).toHaveBeenCalledTimes(2);
  });

  it("recovers from a per-attempt timeout", async () => {
    setConfig({ HORIZON_ACCOUNT_TIMEOUT_MS: 20 });
    h.loadAccount
      .mockImplementationOnce(() => new Promise(() => {})) // hangs past the deadline
      .mockResolvedValue(account);

    await expect(stellar.loadAccount("GABC")).resolves.toMatchObject({ exists: true });
    expect(h.loadAccount).toHaveBeenCalledTimes(2);
  });

  it("recovers from several consecutive rate limits within the budget", async () => {
    h.loadAccount
      .mockRejectedValueOnce(horizonError(429))
      .mockRejectedValueOnce(horizonError(429))
      .mockResolvedValue(account);

    await expect(stellar.loadAccount("GABC")).resolves.toMatchObject({ exists: true });
    expect(h.loadAccount).toHaveBeenCalledTimes(3);
  });

  it("gives up after the configured attempts on a persistent 429", async () => {
    h.loadAccount.mockRejectedValue(horizonError(429));

    await expect(stellar.loadAccount("GABC")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(h.loadAccount).toHaveBeenCalledTimes(3);
  });

  it("honours UPSTREAM_RETRY_MAX_ATTEMPTS", async () => {
    setConfig({ UPSTREAM_RETRY_MAX_ATTEMPTS: 5 });
    h.loadAccount.mockRejectedValue(horizonError(503));

    await expect(stellar.loadAccount("GABC")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(h.loadAccount).toHaveBeenCalledTimes(5);
  });

  it("does not retry 429 when HORIZON_RETRY_ON_RATE_LIMIT is false", async () => {
    setConfig({ HORIZON_RETRY_ON_RATE_LIMIT: false });
    h.loadAccount.mockRejectedValue(horizonError(429));

    await expect(stellar.loadAccount("GABC")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
  });
});

describe("loadAccount — permanent failures are not retried", () => {
  it.each([400, 401, 403, 409, 422, 501, 505])("fails fast on HTTP %i", async (status) => {
    h.loadAccount.mockRejectedValue(horizonError(status));

    await expect(stellar.loadAccount("GABC")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
  });

  it("treats 404 as an unfunded account without retrying", async () => {
    h.loadAccount.mockRejectedValue(
      Object.assign(new Error("Not Found"), { name: "NotFoundError", response: { status: 404 } })
    );

    await expect(stellar.loadAccount("GABC")).resolves.toMatchObject({ exists: false });
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
  });
});

describe("getTransaction", () => {
  it.each([
    ["a network error", networkError],
    ["HTTP 429", () => horizonError(429)],
    ["HTTP 503", () => horizonError(503)],
  ])("recovers from %s", async (_label, make) => {
    h.transactionCall.mockRejectedValueOnce(make()).mockResolvedValue({ successful: true });

    await expect(stellar.getTransaction("abc")).resolves.toEqual({ successful: true });
    expect(h.transactionCall).toHaveBeenCalledTimes(2);
  });

  it("fails fast on HTTP 400", async () => {
    h.transactionCall.mockRejectedValue(horizonError(400));

    await expect(stellar.getTransaction("abc")).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });
    expect(h.transactionCall).toHaveBeenCalledTimes(1);
  });

  it("returns null for a not-yet-visible transaction without retrying", async () => {
    h.transactionCall.mockRejectedValue(
      Object.assign(new Error("Not Found"), { name: "NotFoundError", response: { status: 404 } })
    );

    await expect(stellar.getTransaction("abc")).resolves.toBeNull();
    expect(h.transactionCall).toHaveBeenCalledTimes(1);
  });
});

describe("submissions are never retried (non-idempotent)", () => {
  const source = Keypair.random();
  const destination = Keypair.random().publicKey();

  function signedPayment(): string {
    const xdr = stellar.buildPayment({
      sourcePublicKey: source.publicKey(),
      sourceSequence: "100",
      destination,
      asset: { code: "XLM" },
      amount: "1",
      memoCode: "ABC234",
    });
    const tx = TransactionBuilder.fromXDR(xdr, config.networkPassphrase) as any;
    tx.sign(source);
    return tx.toXDR();
  }

  function signedEnvelope(): string {
    const tx = new TransactionBuilder(new Account(source.publicKey(), "100"), {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(Operation.payment({ destination, asset: Asset.native(), amount: "1" }))
      .setTimeout(300)
      .build();
    tx.sign(source);
    return tx.toXDR();
  }

  const failures: [string, () => unknown][] = [
    ["HTTP 503", () => horizonError(503)],
    ["HTTP 504", () => horizonError(504)],
    ["HTTP 429", () => horizonError(429)],
    ["a network error", networkError],
  ];

  it.each(failures)("submitSigned reaches Horizon exactly once on %s", async (_label, make) => {
    h.submitTransaction.mockRejectedValue(make());

    await expect(stellar.submitSigned(signedEnvelope())).rejects.toBeDefined();
    expect(h.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it.each(failures)("submitPayment reaches Horizon exactly once on %s", async (_label, make) => {
    h.submitTransaction.mockRejectedValue(make());

    await expect(
      stellar.submitPayment(signedPayment(), {
        sourcePublicKey: source.publicKey(),
        destination,
        asset: { code: "XLM" },
        amount: "1",
        memoCode: "ABC234",
      } as any)
    ).rejects.toBeDefined();
    expect(h.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("submitSigned succeeds on the first attempt without extra calls", async () => {
    h.submitTransaction.mockResolvedValue({ hash: "deadbeef" });

    await expect(stellar.submitSigned(signedEnvelope())).resolves.toBe("deadbeef");
    expect(h.submitTransaction).toHaveBeenCalledTimes(1);
  });
});
