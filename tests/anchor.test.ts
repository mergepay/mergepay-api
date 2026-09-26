/**
 * Tests for src/services/anchor.ts
 *
 * Covers:
 *  1. SEP-24 status → internal status mapping (mapAnchorStatus, isTerminalAnchorStatus)
 *  2. SEP-24 webhook signature verification (verifySep24Signature – valid / invalid)
 *  3. Deposit / withdraw session happy paths (anchorService.getToml, getChallenge,
 *     startInteractive) with mocked HTTP
 *  4. Retry / backoff: 5xx retries with backoff; 4xx do not retry; network errors retry
 *
 * All HTTP is mocked via globalThis.fetch — no real network calls are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ── Hoisted mocks ────────────────────────────────────────────────────────────
// vi.hoisted runs before module-scope side effects (config parse, cache init).
const h = vi.hoisted(() => {
  const fetchMock = vi.fn();
  const circuitMock = {
    isOpen: vi.fn(() => false),
    recordFailure: vi.fn(),
    recordSuccess: vi.fn(),
  };
  return { fetchMock, circuitMock };
});

// Stub modules imported by anchor.ts before the import hoists.
vi.mock("../src/services/anchor-circuit", () => ({
  anchorCircuit: h.circuitMock,
}));

vi.mock("../src/config", () => ({
  config: {
    ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
    ANCHOR_TOML_TIMEOUT_MS: 5000,
    ANCHOR_CHALLENGE_TIMEOUT_MS: 5000,
    ANCHOR_TOKEN_TIMEOUT_MS: 5000,
    ANCHOR_INTERACTIVE_TIMEOUT_MS: 5000,
    ANCHOR_POLL_TIMEOUT_MS: 5000,
    networkPassphrase: "Test SDF Network ; September 2015",
    UPSTREAM_RETRY_MAX_ATTEMPTS: 3,
    UPSTREAM_RETRY_INITIAL_DELAY_MS: 100,
    UPSTREAM_RETRY_MAX_DELAY_MS: 1000,
    UPSTREAM_RETRY_JITTER_RATIO: 0,
    SEP24_WEBHOOK_TOLERANCE_MS: 300000,
  },
  env: {
    NODE_ENV: "test",
    DATABASE_QUERY_TIMEOUT_MS: 10000,
  },
}));

vi.mock("../src/db", () => ({
  prisma: {
    anchorSession: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    $transaction: vi.fn(async (fn: any) =>
      fn({
        anchorSession: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn().mockResolvedValue({}),
        },
        auditLog: { create: vi.fn() },
      })
    ),
  },
}));

// Mock global fetch used by anchor.ts
vi.stubGlobal("fetch", h.fetchMock);

// ── Imports after mocks are wired ────────────────────────────────────────────
import {
  mapAnchorStatus,
  isTerminalAnchorStatus,
  anchorService,
  TERMINAL_ANCHOR_STATUSES,
} from "../src/services/anchor";
import {
  verifySep24Signature,
  signSep24Payload,
  SEP24_SIGNATURE_HEADER,
  SEP24_TIMESTAMP_HEADER,
  resetAnchorSecretCache,
} from "../src/services/sep24";

// ── Shared helpers ───────────────────────────────────────────────────────────

const fetchCalls = () => h.fetchMock.mock.calls.length;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    clone: () => jsonResponse(body, status),
    formData: () => Promise.resolve(new FormData()),
    redirected: false,
    statusText: "OK",
    type: "default",
    url: "",
  } as Response;
}

function htmlResponse(html: string, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "text/html" }),
    json: () => Promise.reject(new Error("not JSON")),
    text: () => Promise.resolve(html),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob()),
    clone: () => htmlResponse(html, status),
    formData: () => Promise.resolve(new FormData()),
    redirected: false,
    statusText: "OK",
    type: "default",
    url: "",
  } as Response;
}

const VALID_SECRET = "test-webhook-secret";

const VALID_TOML = `
HOME_DOMAIN = "testanchor.stellar.org"
WEB_AUTH_ENDPOINT = "https://testanchor.stellar.org/auth"
TRANSFER_SERVER_SEP0024 = "https://testanchor.stellar.org/sep24"
SIGNING_KEY = "GTESTSIGNINGKEY1234567890123456789012345678901234567890ABCDEF"
`;

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetAnchorSecretCache();
  h.circuitMock.isOpen.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. Status mapping
// ═════════════════════════════════════════════════════════════════════════════

describe("mapAnchorStatus", () => {
  it.each([
    ["completed", "completed"],
    ["error", "error"],
    ["refunded", "refunded"],
    ["expired", "expired"],
    ["no_market", "no_market"],
    ["too_small", "too_small"],
    ["too_large", "too_large"],
    ["incomplete", "incomplete"],
    ["pending_user_transfer_start", "pending_user_transfer_start"],
    ["pending_stellar", "pending_stellar"],
    ["pending_trust", "pending_trust"],
    ["pending_user", "pending_user"],
    ["pending_anchor", "pending_anchor"],
    ["pending_transaction_info_update", "pending_transaction_info_update"],
    ["pending_receiver", "pending_receiver"],
    ["pending_sender", "pending_sender"],
  ])("maps %s → %s", (input, expected) => {
    expect(mapAnchorStatus(input)).toBe(expected);
  });

  it("maps unknown statuses to pending_anchor", () => {
    expect(mapAnchorStatus("future_new_status_xyz")).toBe("pending_anchor");
  });

  it("maps empty string to pending_anchor", () => {
    expect(mapAnchorStatus("")).toBe("pending_anchor");
  });
});

describe("isTerminalAnchorStatus", () => {
  it("returns true for completed", () => {
    expect(isTerminalAnchorStatus("completed")).toBe(true);
  });

  it("returns true for error", () => {
    expect(isTerminalAnchorStatus("error")).toBe(true);
  });

  it("returns true for refunded", () => {
    expect(isTerminalAnchorStatus("refunded")).toBe(true);
  });

  it.each([
    "incomplete",
    "pending_anchor",
    "pending_stellar",
    "pending_user",
    "expired",
    "no_market",
    "too_small",
    "too_large",
  ])("returns false for %s", (s) => {
    expect(isTerminalAnchorStatus(s)).toBe(false);
  });
});

describe("TERMINAL_ANCHOR_STATUSES set", () => {
  it("contains all terminal statuses", () => {
    expect(TERMINAL_ANCHOR_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_ANCHOR_STATUSES.has("error")).toBe(true);
    expect(TERMINAL_ANCHOR_STATUSES.has("refunded")).toBe(true);
    expect(TERMINAL_ANCHOR_STATUSES.has("expired")).toBe(true);
    expect(TERMINAL_ANCHOR_STATUSES.has("no_market")).toBe(true);
    expect(TERMINAL_ANCHOR_STATUSES.has("too_small")).toBe(true);
    expect(TERMINAL_ANCHOR_STATUSES.has("too_large")).toBe(true);
  });

  it("does not include intermediate statuses", () => {
    expect(TERMINAL_ANCHOR_STATUSES.has("incomplete")).toBe(false);
    expect(TERMINAL_ANCHOR_STATUSES.has("pending_anchor")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Webhook signature verification (HMAC)
// ═════════════════════════════════════════════════════════════════════════════

describe("verifySep24Signature", () => {
  const body = '{"transaction":{"id":"tx_1","status":"completed"}}';

  it("accepts a valid sha256= prefixed signature", () => {
    const sig = crypto.createHmac("sha256", VALID_SECRET).update(body).digest("hex");
    const result = verifySep24Signature({
      rawBody: body,
      headers: { [SEP24_SIGNATURE_HEADER]: `sha256=${sig}` },
      secret: VALID_SECRET,
    });
    expect(result.valid).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("accepts a valid bare hex signature (no prefix)", () => {
    const sig = crypto.createHmac("sha256", VALID_SECRET).update(body).digest("hex");
    const result = verifySep24Signature({
      rawBody: body,
      headers: { [SEP24_SIGNATURE_HEADER]: sig },
      secret: VALID_SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects when signature header is missing", () => {
    const result = verifySep24Signature({
      rawBody: body,
      headers: {},
      secret: VALID_SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("missing_signature");
  });

  it("rejects when signature header is malformed (not 64 hex chars)", () => {
    const result = verifySep24Signature({
      rawBody: body,
      headers: { [SEP24_SIGNATURE_HEADER]: "not-a-signature" },
      secret: VALID_SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("malformed_signature");
  });

  it("rejects when signature does not match (wrong secret)", () => {
    const sig = crypto.createHmac("sha256", "wrong-secret").update(body).digest("hex");
    const result = verifySep24Signature({
      rawBody: body,
      headers: { [SEP24_SIGNATURE_HEADER]: `sha256=${sig}` },
      secret: VALID_SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects when signature matches but body has been tampered", () => {
    const sig = crypto.createHmac("sha256", VALID_SECRET).update(body).digest("hex");
    const tampered = body.replace("completed", "pending_anchor");
    const result = verifySep24Signature({
      rawBody: tampered,
      headers: { [SEP24_SIGNATURE_HEADER]: `sha256=${sig}` },
      secret: VALID_SECRET,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("invalid_signature");
  });

  it("rejects stale timestamp", () => {
    const sig = crypto.createHmac("sha256", VALID_SECRET).update(body).digest("hex");
    // 1000 seconds ago → 1,000,000 ms → > 300,000 ms tolerance
    const staleTimestamp = Math.floor(Date.now() / 1000) - 1000;
    const result = verifySep24Signature({
      rawBody: body,
      headers: {
        [SEP24_SIGNATURE_HEADER]: `sha256=${sig}`,
        [SEP24_TIMESTAMP_HEADER]: String(staleTimestamp),
      },
      secret: VALID_SECRET,
      now: Date.now(),
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("stale_timestamp");
  });

  it("accepts fresh timestamp within tolerance", () => {
    const sig = crypto.createHmac("sha256", VALID_SECRET).update(body).digest("hex");
    const freshTimestamp = Math.floor(Date.now() / 1000) - 10; // 10 seconds ago
    const result = verifySep24Signature({
      rawBody: body,
      headers: {
        [SEP24_SIGNATURE_HEADER]: `sha256=${sig}`,
        [SEP24_TIMESTAMP_HEADER]: String(freshTimestamp),
      },
      secret: VALID_SECRET,
      now: Date.now(),
    });
    expect(result.valid).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Session happy paths (getToml, getChallenge, startInteractive)
//
// NOTE: tomlCache is module-level. Tests use unique domains to avoid hits.
// ═════════════════════════════════════════════════════════════════════════════

describe("anchorService.getToml", () => {
  it("fetches and parses a valid stellar.toml", async () => {
    h.fetchMock.mockResolvedValueOnce(htmlResponse(VALID_TOML));

    const result = await anchorService.getToml("testanchor.stellar.org");

    expect(result.homeDomain).toBe("testanchor.stellar.org");
    expect(result.webAuthEndpoint).toBe("https://testanchor.stellar.org/auth");
    expect(result.transferServerSep24).toBe("https://testanchor.stellar.org/sep24");
    expect(result.signingKey).toBe("GTESTSIGNINGKEY1234567890123456789012345678901234567890ABCDEF");
    expect(fetchCalls()).toBe(1);
    expect(h.fetchMock.mock.calls[0][0]).toBe(
      "https://testanchor.stellar.org/.well-known/stellar.toml"
    );
  });

  it("rejects toml with missing required fields", async () => {
    const incompleteToml = `
HOME_DOMAIN = "missingfields.example.com"
WEB_AUTH_ENDPOINT = "https://missingfields.example.com/auth"
`;
    h.fetchMock.mockResolvedValueOnce(htmlResponse(incompleteToml));

    await expect(
      anchorService.getToml("missingfields.example.com")
    ).rejects.toThrow("missing required SEP-24 fields");
    expect(h.circuitMock.recordFailure).toHaveBeenCalled();
  });

  it("rejects invalid TOML content", async () => {
    h.fetchMock.mockResolvedValueOnce(htmlResponse("not valid toml {{{{"));

    await expect(
      anchorService.getToml("invalidtoml.example.com")
    ).rejects.toThrow("invalid stellar.toml");
    expect(h.circuitMock.recordFailure).toHaveBeenCalled();
  });

  it("calls circuit recordFailure on fetch error", async () => {
    h.fetchMock.mockRejectedValueOnce(new Error("network error"));

    await expect(
      anchorService.getToml("fetcherror.example.com")
    ).rejects.toThrow();
    expect(h.circuitMock.recordFailure).toHaveBeenCalled();
  });

  it("blocks call when circuit is open", async () => {
    h.circuitMock.isOpen.mockReturnValue(true);

    await expect(
      anchorService.getToml("circuitopen.example.com")
    ).rejects.toThrow("Circuit open");
    expect(fetchCalls()).toBe(0);
  });
});

describe("anchorService.getChallenge", () => {
  it("fetches a SEP-10 challenge and returns it", async () => {
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ transaction: "AAAAAG...", network_passphrase: "Test SDF Network" })
    );

    const result = await anchorService.getChallenge(
      "https://testanchor.stellar.org/auth",
      "GABC12345678901234567890123456789012345678901234567890ABCDE"
    );

    expect(result.transaction).toBe("AAAAAG...");
    expect(result.networkPassphrase).toBe("Test SDF Network");
    expect(fetchCalls()).toBe(1);
    expect(h.fetchMock.mock.calls[0][0]).toContain("account=GABC1234567890");
  });

  it("falls back to default network passphrase when not provided", async () => {
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ transaction: "AAAAAG..." }));

    const result = await anchorService.getChallenge(
      "https://testanchor.stellar.org/auth",
      "GABC12345678901234567890123456789012345678901234567890ABCDE"
    );

    expect(result.networkPassphrase).toBe("Test SDF Network ; September 2015");
  });
});

describe("anchorService.startInteractive", () => {
  it("starts a deposit interactive flow", async () => {
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        url: "https://testanchor.stellar.org/interactive/deposit?token=abc",
        id: "tx_interactive_1",
      })
    );

    const result = await anchorService.startInteractive({
      transferServer: "https://testanchor.stellar.org/sep24",
      token: "anchor-jwt-token",
      kind: "deposit",
      assetCode: "USDC",
      account: "GABC12345678901234567890123456789012345678901234567890ABCDE",
    });

    expect(result.url).toContain("interactive/deposit");
    expect(result.id).toBe("tx_interactive_1");

    const [url, opts] = h.fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://testanchor.stellar.org/sep24/transactions/deposit/interactive"
    );
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bearer anchor-jwt-token");
  });

  it("starts a withdrawal interactive flow", async () => {
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        url: "https://testanchor.stellar.org/interactive/withdraw?token=def",
        id: "tx_withdraw_2",
      })
    );

    const result = await anchorService.startInteractive({
      transferServer: "https://testanchor.stellar.org/sep24",
      token: "anchor-jwt-token",
      kind: "withdrawal",
      assetCode: "USDC",
      account: "GABC12345678901234567890123456789012345678901234567890ABCDE",
    });

    expect(result.url).toContain("interactive/withdraw");
    expect(result.id).toBe("tx_withdraw_2");

    const [url] = h.fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://testanchor.stellar.org/sep24/transactions/withdraw/interactive"
    );
  });

  it("throws on non-OK response", async () => {
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad request" }, 400));

    await expect(
      anchorService.startInteractive({
        transferServer: "https://testanchor.stellar.org/sep24",
        token: "bad-token",
        kind: "deposit",
        assetCode: "USDC",
        account: "GABC12345678901234567890123456789012345678901234567890ABCDE",
      })
    ).rejects.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Retry / backoff behaviour
// ═════════════════════════════════════════════════════════════════════════════

describe("retry / backoff via fetchReadWithRetry", () => {
  describe("5xx errors retry", () => {
    it("retries on 500 then succeeds", async () => {
      h.fetchMock
        .mockResolvedValueOnce(jsonResponse({ error: "internal" }, 500))
        .mockResolvedValueOnce(
          jsonResponse({ transaction: { status: "pending_anchor", id: "tx_1" } })
        );

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBe("pending_anchor");
      expect(fetchCalls()).toBe(2);
    });

    it("retries on 503 and exhausts budget", async () => {
      h.fetchMock.mockRejectedValue(new Error("upstream unavailable"));

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBeNull();
      expect(fetchCalls()).toBe(3);
      expect(h.circuitMock.recordFailure).toHaveBeenCalled();
    });
  });

  describe("4xx errors do not retry", () => {
    it("does not retry on 400", async () => {
      h.fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad" }, 400));

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBeNull();
      expect(fetchCalls()).toBe(1);
    });

    it("does not retry on 404", async () => {
      h.fetchMock.mockResolvedValueOnce(jsonResponse({ error: "not found" }, 404));

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBeNull();
      expect(fetchCalls()).toBe(1);
    });

    it("does not retry on 401", async () => {
      h.fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "unauthorized" }, 401)
      );

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBeNull();
      expect(fetchCalls()).toBe(1);
    });
  });

  describe("network errors retry", () => {
    it("retries on fetch rejection (network error) then succeeds", async () => {
      h.fetchMock
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          jsonResponse({ transaction: { status: "completed", id: "tx_1" } })
        );

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBe("completed");
      expect(fetchCalls()).toBe(2);
    });
  });

  describe("circuit breaker integration", () => {
    it("returns null and does not call anchor when circuit is open", async () => {
      h.circuitMock.isOpen.mockReturnValue(true);

      const result = await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(result).toBeNull();
      expect(fetchCalls()).toBe(0);
    });

    it("records success on successful poll", async () => {
      h.fetchMock.mockResolvedValueOnce(
        jsonResponse({ transaction: { status: "completed", id: "tx_1" } })
      );

      await anchorService.getTransactionStatus({
        transferServer: "https://anchor.example.com",
        token: "jwt",
        id: "tx_1",
      });

      expect(h.circuitMock.recordSuccess).toHaveBeenCalled();
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. pollTransaction — rich PollResult
// ═════════════════════════════════════════════════════════════════════════════

describe("anchorService.pollTransaction", () => {
  it("returns a full PollResult on success with status mapping", async () => {
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({
        transaction: {
          status: "completed",
          id: "tx_1",
          kind: "deposit",
          amount_in: "100.00",
          amount_out: "99.50",
          amount_fee: "0.50",
          stellar_transaction_hash: "abc123hash",
          started_at: "2026-01-01T00:00:00Z",
          completed_at: "2026-01-01T00:05:00Z",
        },
      })
    );

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example.com",
      token: "jwt",
      id: "tx_1",
    });

    expect(result.rawStatus).toBe("completed");
    expect(result.status).toBe("completed");
    expect(result.isError).toBe(false);
    expect(result.amountIn).toBe("100.00");
    expect(result.amountOut).toBe("99.50");
    expect(result.amountFee).toBe("0.50");
    expect(result.stellarTransactionHash).toBe("abc123hash");
    expect(result.transaction).toBeDefined();
    expect(result.transaction!.id).toBe("tx_1");
  });

  it("returns isError when anchor call fails", async () => {
    h.fetchMock.mockRejectedValue(new Error("connection reset"));

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example.com",
      token: "jwt",
      id: "tx_1",
    });

    expect(result.isError).toBe(true);
    expect(result.status).toBe("pending_anchor");
    expect(result.rawStatus).toBeNull();
  });

  it("returns isError for non-JSON response", async () => {
    h.fetchMock.mockResolvedValueOnce(htmlResponse("not json"));

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example.com",
      token: "jwt",
      id: "tx_1",
    });

    expect(result.isError).toBe(true);
    expect(result.message).toContain("malformed");
  });

  it("returns isError when transaction field is missing", async () => {
    h.fetchMock.mockResolvedValueOnce(jsonResponse({ other: "data" }));

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example.com",
      token: "jwt",
      id: "tx_1",
    });

    expect(result.isError).toBe(true);
    expect(result.message).toContain("missing 'transaction'");
  });

  it("returns isError when transaction status is missing", async () => {
    h.fetchMock.mockResolvedValueOnce(
      jsonResponse({ transaction: { id: "tx_1" } })
    );

    const result = await anchorService.pollTransaction({
      transferServer: "https://anchor.example.com",
      token: "jwt",
      id: "tx_1",
    });

    expect(result.isError).toBe(true);
    expect(result.message).toContain("missing transaction status");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6. Toml caching
// ═════════════════════════════════════════════════════════════════════════════

describe("anchorService.getToml caching", () => {
  it("returns cached toml on second call without fetching again", async () => {
    // Use a unique domain so no prior test has cached this
    const domain = "cachetest.stellar.org";
    h.fetchMock.mockResolvedValueOnce(htmlResponse(VALID_TOML));

    await anchorService.getToml(domain);
    expect(fetchCalls()).toBe(1);

    // Second call should hit cache — no new fetch
    await anchorService.getToml(domain);
    expect(fetchCalls()).toBe(1);
  });
});
