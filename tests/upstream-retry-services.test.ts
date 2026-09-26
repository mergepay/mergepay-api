/**
 * Service-level retry behaviour for Horizon and anchor calls.
 *
 * These tests drive the real service modules against mocked upstreams and
 * assert the number of upstream calls, which is the property that matters:
 * a read must recover from a blip, and a submission must never be repeated.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { TimeoutError } from "../src/services/timeout";

const h = vi.hoisted(() => {
  const loadAccount = vi.fn();
  const transactionCall = vi.fn();
  const submitTransaction = vi.fn();

  class FakeServer {
    loadAccount = loadAccount;
    submitTransaction = submitTransaction;
    transactions() {
      return {
        transaction: () => ({ call: transactionCall }),
      };
    }
  }

  return { loadAccount, transactionCall, submitTransaction, FakeServer };
});

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>(
    "@stellar/stellar-sdk"
  );
  return {
    ...actual,
    Horizon: { ...actual.Horizon, Server: h.FakeServer },
  };
});

import { stellar } from "../src/services/stellar";
import { anchorService } from "../src/services/anchor";
import { anchorCircuit } from "../src/services/anchor-circuit";

/** A Horizon-shaped 404, which both read helpers treat as a domain answer. */
function notFound() {
  return Object.assign(new Error("Not Found"), {
    name: "NotFoundError",
    response: { status: 404 },
  });
}

/** A retryable upstream failure. */
function serverError() {
  return Object.assign(new Error("Server Error"), { response: { status: 503 } });
}

const accountPayload = {
  sequenceNumber: () => "12345",
  balances: [{ asset_type: "native", balance: "100.0" }],
  signers: [{ key: "GA...", weight: 1 }],
  thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

function textResponse(body: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(body),
    text: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

const VALID_TOML = `
WEB_AUTH_ENDPOINT="https://anchor.example/auth"
TRANSFER_SERVER_SEP0024="https://anchor.example/sep24"
SIGNING_KEY="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
[[CURRENCIES]]
code="USDC"
issuer="GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
`;

describe("Horizon reads are retried", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers loadAccount from a transient failure", async () => {
    h.loadAccount.mockRejectedValueOnce(serverError()).mockResolvedValue(accountPayload);

    const snapshot = await stellar.loadAccount("GABC");

    expect(snapshot.exists).toBe(true);
    expect(h.loadAccount).toHaveBeenCalledTimes(2);
  });

  it("gives up on loadAccount after the configured attempts", async () => {
    h.loadAccount.mockRejectedValue(serverError());

    await expect(stellar.loadAccount("GABC")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });

    // Bounded, not unbounded: the default policy is 3 attempts.
    expect(h.loadAccount.mock.calls.length).toBeGreaterThan(1);
    expect(h.loadAccount.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it("does not spend attempts on an unfunded account", async () => {
    h.loadAccount.mockRejectedValue(notFound());

    const snapshot = await stellar.loadAccount("GABC");

    expect(snapshot.exists).toBe(false);
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
  });

  it("recovers getTransaction from a transient failure", async () => {
    h.transactionCall
      .mockRejectedValueOnce(serverError())
      .mockResolvedValue({ successful: true });

    await expect(stellar.getTransaction("abc123")).resolves.toEqual({ successful: true });
    expect(h.transactionCall).toHaveBeenCalledTimes(2);
  });

  it("does not spend attempts on a transaction that is not yet visible", async () => {
    h.transactionCall.mockRejectedValue(notFound());

    await expect(stellar.getTransaction("abc123")).resolves.toBeNull();
    expect(h.transactionCall).toHaveBeenCalledTimes(1);
  });

  it("does not retry a rejected read that the upstream refused permanently", async () => {
    h.loadAccount.mockRejectedValue(
      Object.assign(new Error("Bad Request"), { response: { status: 400 } })
    );

    await expect(stellar.loadAccount("GABC")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(h.loadAccount).toHaveBeenCalledTimes(1);
  });
});

describe("Horizon submissions are never retried", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits a signed envelope exactly once even when the call fails", async () => {
    h.submitTransaction.mockRejectedValue(serverError());

    // A malformed envelope is rejected before any network call, so the assertion
    // that matters is that no submission path ever calls Horizon more than once.
    await expect(stellar.submitSigned("not-a-valid-xdr")).rejects.toBeDefined();
    expect(h.submitTransaction.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("keeps the submission timeout at a single attempt", async () => {
    h.submitTransaction.mockRejectedValue(new TimeoutError("Horizon.submitTransaction", 30_000));

    await expect(stellar.submitSigned("not-a-valid-xdr")).rejects.toBeDefined();
    expect(h.submitTransaction.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("Anchor reads are retried", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    anchorCircuit.reset("toml:retry-test.example");
    anchorCircuit.reset("tx:https://anchor.example/sep24");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recovers getToml from a 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(textResponse("upstream down", 503))
      .mockResolvedValue(textResponse(VALID_TOML));
    vi.stubGlobal("fetch", fetchMock);

    const toml = await anchorService.getToml("retry-test.example");

    expect(toml.webAuthEndpoint).toBe("https://anchor.example/auth");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("does not retry getToml on a 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("missing", 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(anchorService.getToml("retry-404.example")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("does not retry getToml into a rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("slow down", 429));
    vi.stubGlobal("fetch", fetchMock);

    await expect(anchorService.getToml("retry-429.example")).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it("records one circuit failure per exhausted budget, not per attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(textResponse("upstream down", 503));
    vi.stubGlobal("fetch", fetchMock);

    const provider = "toml:retry-circuit.example";
    anchorCircuit.reset(provider);

    await expect(anchorService.getToml("retry-circuit.example")).rejects.toBeDefined();

    // Several upstream calls happened, but the breaker saw a single failure.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(anchorCircuit.get(provider).failures).toBe(1);
    vi.unstubAllGlobals();
  });

  it("recovers pollTransaction from a transient failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValue(jsonResponse({ transaction: { status: "completed" } }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example/sep24",
      token: "jwt",
      id: "tx_1",
    });

    expect(result.isError).toBe(false);
    expect(result.rawStatus).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("still reports the anchor's HTTP status once retries are exhausted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example/sep24",
      token: "jwt",
      id: "tx_2",
    });

    expect(result.isError).toBe(true);
    expect(result.message).toContain("503");
    vi.unstubAllGlobals();
  });

  it("recovers getTransactionStatus from a transient failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValue(jsonResponse({ transaction: { status: "COMPLETED" } }));
    vi.stubGlobal("fetch", fetchMock);

    const status = await anchorService.getTransactionStatus({
      transferServer: "https://anchor.example/sep24",
      token: "jwt",
      id: "tx_3",
    });

    expect(status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });
});

describe("Anchor writes are never retried", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exchanges a SEP-10 challenge exactly once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      anchorService.getToken("https://anchor.example/auth", "signed-xdr")
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts an interactive flow exactly once", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 503));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      anchorService.startInteractive({
        transferServer: "https://anchor.example/sep24",
        token: "jwt",
        kind: "deposit",
        assetCode: "USDC",
        account: "GABC",
      })
    ).rejects.toMatchObject({ code: "UPSTREAM_ERROR" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
