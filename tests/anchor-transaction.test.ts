/**
 * Tests for the typed SEP-24 `GET /transaction` read (issue #524):
 * `anchorService.getTransaction`, the Zod response schema, status resolution,
 * the typed anchor errors, and the bounded retry policy.
 *
 * All HTTP is mocked via a stubbed global fetch returning real `Response`
 * objects — no network is touched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  circuitMock: {
    isOpen: vi.fn(() => false),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  },
}));

vi.mock("../src/services/anchor-circuit", () => ({ anchorCircuit: h.circuitMock }));

vi.mock("../src/config", () => ({
  config: {
    ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
    ANCHOR_POLL_TIMEOUT_MS: 5000,
    networkPassphrase: "Test SDF Network ; September 2015",
    UPSTREAM_RETRY_MAX_ATTEMPTS: 3,
    UPSTREAM_RETRY_INITIAL_DELAY_MS: 1,
    UPSTREAM_RETRY_MAX_DELAY_MS: 1,
    UPSTREAM_RETRY_JITTER_RATIO: 0,
  },
  env: { NODE_ENV: "test", DATABASE_QUERY_TIMEOUT_MS: 10000 },
}));

import { anchorService } from "../src/services/anchor";
import {
  AnchorAuthError,
  AnchorError,
  AnchorNetworkError,
  AnchorNotFoundError,
  AnchorTimeoutError,
  AnchorUnavailableError,
  AnchorUpstreamError,
  AnchorValidationError,
} from "../src/services/anchor-errors";
import {
  parseSep24TransactionResponse,
  resolveSep24Status,
} from "../src/services/anchor-schemas";
import { ProviderError } from "../src/lib/provider-error";

const TRANSFER_SERVER = "https://anchor.example/sep24";
const TOKEN = "secret-sep10-jwt";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that never answers, but honours the abort signal like real fetch. */
function hangingFetch(_url: string, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    });
  });
}

function tx(over: Record<string, unknown> = {}) {
  return { id: "tx_1", kind: "deposit", status: "pending_anchor", ...over };
}

function getTransaction(id = "tx_1", timeoutMs?: number) {
  return anchorService.getTransaction({ transferServer: TRANSFER_SERVER, token: TOKEN, id, timeoutMs });
}

/** Resolve to the rejection, failing the test if the call succeeds. */
async function rejectionOf(promise: Promise<unknown>): Promise<AnchorError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AnchorError);
    return err as AnchorError;
  }
  throw new Error("expected the anchor call to fail");
}

beforeEach(() => {
  h.fetchMock.mockReset();
  h.circuitMock.isOpen.mockReset().mockReturnValue(false);
  h.circuitMock.recordFailure.mockReset();
  h.circuitMock.recordSuccess.mockReset();
  vi.stubGlobal("fetch", h.fetchMock);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ─── 1. Typed parsing ────────────────────────────────────────────────────────

describe("getTransaction — valid responses", () => {
  it("parses a completed deposit, keeping every amount as an exact string", async () => {
    h.fetchMock.mockResolvedValueOnce(
      json({
        transaction: tx({
          status: "completed",
          amount_in: "100.0000001",
          amount_out: "99.5000001",
          amount_fee: "0.5",
          amount_in_asset: "iso4217:USD",
          started_at: "2026-09-01T10:00:00Z",
          completed_at: "2026-09-01T10:05:00Z",
          stellar_transaction_id: "a".repeat(64),
          external_transaction_id: "bank-123",
          more_info_url: "https://anchor.example/tx/tx_1",
        }),
      })
    );

    const result = await getTransaction();

    expect(result).toMatchObject({
      id: "tx_1",
      kind: "deposit",
      status: "completed",
      amount_in: "100.0000001",
      amount_out: "99.5000001",
      amount_fee: "0.5",
      stellar_transaction_id: "a".repeat(64),
      external_transaction_id: "bank-123",
    });
    expect(typeof result.amount_in).toBe("string");
    expect(h.circuitMock.recordSuccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["deposit", "pending_user_transfer_start"],
    ["deposit", "pending_trust"],
    ["withdrawal", "pending_user_transfer_start"],
    ["withdrawal", "pending_anchor"],
    ["withdrawal", "pending_stellar"],
    ["withdrawal", "refunded"],
  ])("parses a %s in %s", async (kind, status) => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ kind, status }) }));

    const result = await getTransaction();

    expect(result.kind).toBe(kind);
    expect(result.status).toBe(status);
  });

  it("normalizes the status to trimmed lower case", async () => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ status: "  COMPLETED " }) }));
    expect((await getTransaction()).status).toBe("completed");
  });

  it("sends the SEP-10 token as a bearer header to /transaction?id=", async () => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ id: "tx/1" }) }));

    await getTransaction("tx/1");

    const [url, init] = h.fetchMock.mock.calls[0];
    expect(url).toBe(`${TRANSFER_SERVER}/transaction?id=tx%2F1`);
    expect((init as RequestInit).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
  });

  it("parses a refunds object with string amounts", async () => {
    const refunds = {
      amount_refunded: "10",
      amount_fee: "1",
      payments: [{ id: "b".repeat(64), id_type: "stellar", amount: "9", fee: "1" }],
    };
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ status: "refunded", refunds }) }));

    expect((await getTransaction()).refunds).toEqual(refunds);
  });
});

// ─── 2. Unknown fields accepted; required fields enforced ───────────────────

describe("getTransaction — schema enforcement", () => {
  it("accepts and strips unknown fields at every level", async () => {
    h.fetchMock.mockResolvedValueOnce(
      json({
        transaction: tx({ bank_account: "DE89 3704 0044", anchor_internal: { a: 1 } }),
        extra_top_level: true,
      })
    );

    const result = await getTransaction();

    expect(result.status).toBe("pending_anchor");
    expect(result).not.toHaveProperty("bank_account");
    expect(result).not.toHaveProperty("anchor_internal");
  });

  it.each([
    ["id", { id: undefined }, "transaction.id"],
    ["kind", { kind: undefined }, "transaction.kind"],
    ["status", { status: undefined }, "transaction.status"],
  ])("rejects a transaction missing its %s", async (_field, over, path) => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx(over) }));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorValidationError);
    expect((err as AnchorValidationError).reason).toBe("schema");
    expect((err as AnchorValidationError).fields).toContain(path);
    expect(err.category).toBe("malformed");
    expect(h.circuitMock.recordFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an unknown kind", { kind: "exchange" }],
    ["a blank status", { status: "   " }],
    ["a numeric status", { status: 3 }],
    ["an empty id", { id: "" }],
  ])("rejects %s", async (_label, over) => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx(over) }));
    expect(await rejectionOf(getTransaction())).toBeInstanceOf(AnchorValidationError);
  });

  it("rejects a body with no transaction envelope", async () => {
    h.fetchMock.mockResolvedValueOnce(json({ id: "tx_1", status: "completed" }));

    const err = (await rejectionOf(getTransaction())) as AnchorValidationError;

    expect(err).toBeInstanceOf(AnchorValidationError);
    expect(err.fields).toEqual(["transaction"]);
  });

  it("rejects a response for a different transaction than requested", async () => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ id: "someone_elses_tx" }) }));

    const err = (await rejectionOf(getTransaction("tx_1"))) as AnchorValidationError;

    expect(err.reason).toBe("id_mismatch");
  });

  it("drops a malformed optional field instead of failing the whole transaction", async () => {
    h.fetchMock.mockResolvedValueOnce(
      json({ transaction: tx({ status: "completed", amount_in: 100.5, amount_out: "99" }) })
    );

    const result = await getTransaction();

    // A JSON number is already a float — never turned into a money string.
    expect(result.amount_in).toBeUndefined();
    expect(result.amount_out).toBe("99");
    expect(result.status).toBe("completed");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("invalid optional fields"),
      expect.stringContaining("transaction.amount_in")
    );
  });

  it("still fails when a required field is invalid alongside a bad optional one", () => {
    const result = parseSep24TransactionResponse({
      transaction: { id: "tx_1", status: "completed", amount_in: 1 },
    });
    expect(result).toEqual({ success: false, fields: ["transaction.kind", "transaction.amount_in"] });
  });
});

// ─── 3. Unknown statuses ─────────────────────────────────────────────────────

describe("unknown and legacy statuses", () => {
  it("returns an unknown status as-is from getTransaction without failing", async () => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ status: "pending_quantum_review" }) }));

    const result = await getTransaction();

    expect(result.status).toBe("pending_quantum_review");
    expect(resolveSep24Status(result.status)).toEqual({ recognized: false, status: null });
  });

  it("flags an unknown status on the poll result so the worker keeps the current state", async () => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx({ status: "pending_quantum_review" }) }));

    const result = await anchorService.pollTransaction({
      transferServer: TRANSFER_SERVER,
      token: TOKEN,
      id: "tx_1",
    });

    expect(result.isError).toBe(false);
    expect(result.recognized).toBe(false);
    expect(result.rawStatus).toBe("pending_quantum_review");
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("unknown status"),
      expect.any(String)
    );
  });

  it.each([
    [{ id: "other_tx" }, "transaction id does not match the request"],
    [{ kind: "exchange" }, "invalid fields (transaction.kind)"],
  ])("reports a permanent poll failure for an invalid transaction (%o)", async (over, detail) => {
    h.fetchMock.mockResolvedValueOnce(json({ transaction: tx(over) }));

    const result = await anchorService.pollTransaction({
      transferServer: TRANSFER_SERVER,
      token: TOKEN,
      id: "tx_1",
    });

    expect(result).toMatchObject({
      isError: true,
      category: "malformed",
      errorCategory: "permanent",
      message: `Anchor returned invalid or malformed response: ${detail}`,
    });
    expect(result.error).toBeInstanceOf(AnchorValidationError);
  });

  it.each(["pending_external", "pending_user_transfer_complete"])(
    "recognizes the deprecated status %s as pending_anchor",
    (status) => {
      expect(resolveSep24Status(status)).toEqual({
        recognized: true,
        status: "pending_anchor",
        legacy: true,
      });
    }
  );

  it("resolves every current SEP-24 status to itself", () => {
    for (const status of ["incomplete", "pending_user_transfer_start", "pending_user",
      "pending_transaction_info_update", "pending_receiver", "pending_sender",
      "pending_stellar", "pending_trust", "pending_anchor", "completed", "error",
      "refunded", "expired", "no_market", "too_small", "too_large"]) {
      expect(resolveSep24Status(status)).toEqual({ recognized: true, status, legacy: false });
    }
  });
});

// ─── 4–6. Typed failures ─────────────────────────────────────────────────────

describe("getTransaction — typed failures", () => {
  it("raises AnchorTimeoutError when the anchor never answers", async () => {
    h.fetchMock.mockImplementation(hangingFetch);

    const err = await rejectionOf(getTransaction("tx_1", 10));

    expect(err).toBeInstanceOf(AnchorTimeoutError);
    expect(err.category).toBe("timeout");
    // A read: each attempt was bounded and the whole budget was used.
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    expect(h.circuitMock.recordFailure).toHaveBeenCalledTimes(1);
  });

  it("maps an anchor HTTP 408 onto AnchorTimeoutError", async () => {
    h.fetchMock.mockResolvedValue(json({}, 408));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorTimeoutError);
    expect(err.httpStatus).toBe(408);
  });

  it("raises AnchorNetworkError for a transport failure", async () => {
    h.fetchMock.mockRejectedValue(new TypeError("fetch failed"));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorNetworkError);
    expect(err.category).toBe("transport");
    expect(h.fetchMock).toHaveBeenCalledTimes(3);
  });

  it("raises AnchorNotFoundError for a 404 without retrying", async () => {
    h.fetchMock.mockResolvedValue(json({ error: "not found" }, 404));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorNotFoundError);
    expect(err.httpStatus).toBe(404);
    expect(err.category).toBe("rejected");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403] as const)("raises AnchorAuthError for %s without retrying", async (status) => {
    h.fetchMock.mockResolvedValue(json({ error: "token expired" }, status));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorAuthError);
    expect(err.httpStatus).toBe(status);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503])("raises AnchorUpstreamError carrying HTTP %s", async (status) => {
    h.fetchMock.mockResolvedValue(json({ error: "down" }, status));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorUpstreamError);
    expect(err.httpStatus).toBe(status);
    expect(err.category).toBe("unavailable");
  });

  it("raises AnchorUpstreamError for 429 as a rate limit, without retrying into it", async () => {
    h.fetchMock.mockResolvedValue(json({}, 429));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorUpstreamError);
    expect(err.category).toBe("rate_limited");
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("raises AnchorValidationError for a non-JSON body", async () => {
    h.fetchMock.mockResolvedValueOnce(new Response("<html>maintenance</html>", { status: 200 }));

    const err = (await rejectionOf(getTransaction())) as AnchorValidationError;

    expect(err).toBeInstanceOf(AnchorValidationError);
    expect(err.reason).toBe("invalid_json");
  });

  it("raises AnchorUnavailableError without calling the anchor when the circuit is open", async () => {
    h.circuitMock.isOpen.mockReturnValue(true);

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(AnchorUnavailableError);
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps every anchor error a 502 ProviderError that never leaks the token or body", async () => {
    h.fetchMock.mockResolvedValue(json({ error: `bad token ${TOKEN}` }, 401));

    const err = await rejectionOf(getTransaction());

    expect(err).toBeInstanceOf(ProviderError);
    expect(err.status).toBe(502);
    expect(err.code).toBe("PROVIDER_REJECTED");
    expect(err.message).not.toContain(TOKEN);
    expect(err.message).not.toContain("bad token");
  });
});

// ─── 7. Retry policy ─────────────────────────────────────────────────────────

describe("getTransaction — bounded retries", () => {
  it("retries a 503 and succeeds on the next attempt", async () => {
    h.fetchMock
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ transaction: tx({ status: "completed" }) }));

    expect((await getTransaction()).status).toBe("completed");
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(h.circuitMock.recordFailure).not.toHaveBeenCalled();
  });

  it("stops after exactly UPSTREAM_RETRY_MAX_ATTEMPTS attempts", async () => {
    h.fetchMock.mockResolvedValue(json({}, 500));

    await rejectionOf(getTransaction());

    expect(h.fetchMock).toHaveBeenCalledTimes(3);
    // One exhausted budget is one failure against the circuit, not three.
    expect(h.circuitMock.recordFailure).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 404, 429, 501])("does not retry HTTP %s", async (status) => {
    h.fetchMock.mockResolvedValue(json({}, status));

    await rejectionOf(getTransaction());

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a malformed 200 response", async () => {
    h.fetchMock.mockResolvedValue(json({ transaction: { id: "tx_1" } }));

    await rejectionOf(getTransaction());

    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});
