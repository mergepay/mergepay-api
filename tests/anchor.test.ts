import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import {
  anchorService,
  mapAnchorStatus,
  verifyWebhookSignature,
  AnchorToml,
} from "../src/services/anchor";
import { Errors } from "../src/errors";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Helper to create mock Response
function createMockResponse(
  body: unknown,
  status = 200,
  statusText = "OK"
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

describe("Anchor Service - Status Mapping", () => {
  it.each([
    ["completed", "completed"],
    ["pending_user_transfer_start", "pending_user_transfer_start"],
    ["error", "error"],
    ["too_small", "error"],
    ["too_large", "error"],
    ["refunded", "refunded"],
    ["incomplete", "incomplete"],
    ["unknown_status", "pending_anchor"],
    ["", "pending_anchor"],
  ])("maps '%s' to '%s'", (input, expected) => {
    expect(mapAnchorStatus(input)).toBe(expected);
  });
});

describe("Anchor Service - Webhook Signature Verification", () => {
  const secret = "test-signing-key-12345";
  const payload = JSON.stringify({ id: "tx123", status: "completed" });

  it("accepts a valid signature", () => {
    const signature = `sha256=${createHmac("sha256", secret)
      .update(payload)
      .digest("hex")}`;
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(true);
  });

  it("rejects an invalid signature", () => {
    const invalidSignature = "sha256=invalidsignature1234567890abcdef";
    expect(verifyWebhookSignature(payload, invalidSignature, secret)).toBe(
      false
    );
  });

  it("rejects a signature from wrong secret", () => {
    const wrongSecret = "wrong-signing-key";
    const signature = `sha256=${createHmac("sha256", wrongSecret)
      .update(payload)
      .digest("hex")}`;
    expect(verifyWebhookSignature(payload, signature, secret)).toBe(false);
  });

  it("rejects tampered payload", () => {
    const signature = `sha256=${createHmac("sha256", secret)
      .update(payload)
      .digest("hex")}`;
    const tamperedPayload = JSON.stringify({ id: "tx123", status: "pending" });
    expect(verifyWebhookSignature(tamperedPayload, signature, secret)).toBe(
      false
    );
  });

  it("rejects malformed signature (missing prefix)", () => {
    const hex = createHmac("sha256", secret).update(payload).digest("hex");
    expect(verifyWebhookSignature(payload, hex, secret)).toBe(false);
  });

  it("rejects empty signature", () => {
    expect(verifyWebhookSignature(payload, "", secret)).toBe(false);
  });
});

describe("Anchor Service - TOML Fetching", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    anchorService.clearTomlCache();
  });

  it("fetches and parses stellar.toml", async () => {
    const tomlContent = `
      WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
      TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/transfer"
      SIGNING_KEY = "GCXXXXXXX"
      CURRENCIES = [
        { code = "USDC", issuer = "CGDSXXXX" },
        { code = "XLM" }
      ]
    `;
    mockFetch.mockResolvedValueOnce(createMockResponse(tomlContent));

    const result = await anchorService.getToml("anchor.example.com");

    expect(result.homeDomain).toBe("anchor.example.com");
    expect(result.webAuthEndpoint).toBe("https://anchor.example.com/auth");
    expect(result.transferServerSep24).toBe(
      "https://anchor.example.com/transfer"
    );
    expect(result.signingKey).toBe("GCXXXXXXX");
    expect(result.assets).toHaveLength(2);
    expect(result.assets[0]).toEqual({ code: "USDC", issuer: "CGDSXXXX" });
    expect(result.assets[1]).toEqual({ code: "XLM", issuer: null });
  });

  it("returns cached value within TTL", async () => {
    const tomlContent = `
      WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
      TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/transfer"
      SIGNING_KEY = "GCXXXXXXX"
    `;
    mockFetch.mockResolvedValueOnce(createMockResponse(tomlContent));

    const result1 = await anchorService.getToml("anchor.example.com");
    const result2 = await anchorService.getToml("anchor.example.com");

    expect(result1).toBe(result2); // Same object reference
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("throws upstream error on failed fetch", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse("Not Found", 404, "Not Found")
    );

    await expect(
      anchorService.getToml("anchor.example.com")
    ).rejects.toThrow(Errors.upstream("").constructor);
  });
});

describe("Anchor Service - SEP-10 Challenge", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("retrieves a SEP-10 challenge", async () => {
    const challengeData = {
      transaction: "AAAAfakechallengeXDR",
      network_passphrase: "Test SDF Network ; September 2015",
    };
    mockFetch.mockResolvedValueOnce(createMockResponse(challengeData));

    const result = await anchorService.getChallenge(
      "https://anchor.example.com/auth",
      "GCXXXXXXX"
    );

    expect(result.transaction).toBe("AAAAfakechallengeXDR");
    expect(result.networkPassphrase).toBe("Test SDF Network ; September 2015");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://anchor.example.com/auth?account=GCXXXXXXX",
      undefined
    );
  });

  it("uses default network passphrase when not provided", async () => {
    const challengeData = {
      transaction: "AAAAfakechallengeXDR",
    };
    mockFetch.mockResolvedValueOnce(createMockResponse(challengeData));

    const result = await anchorService.getChallenge(
      "https://anchor.example.com/auth",
      "GCXXXXXXX"
    );

    // The default should come from config
    expect(result.transaction).toBe("AAAAfakechallengeXDR");
  });
});

describe("Anchor Service - SEP-10 Token Exchange", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("exchanges signed challenge for token", async () => {
    const tokenData = { token: "jwt-token-12345" };
    mockFetch.mockResolvedValueOnce(createMockResponse(tokenData));

    const result = await anchorService.getToken(
      "https://anchor.example.com/auth",
      "SIGNEDXDR123"
    );

    expect(result).toBe("jwt-token-12345");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://anchor.example.com/auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transaction: "SIGNEDXDR123" }),
      }
    );
  });

  it("throws on token exchange failure", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ error: "invalid signature" }, 400, "Bad Request")
    );

    await expect(
      anchorService.getToken("https://anchor.example.com/auth", "INVALIDXDR")
    ).rejects.toThrow(Errors.upstream("").constructor);
  });
});

describe("Anchor Service - SEP-24 Interactive Flow", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("starts a deposit transaction", async () => {
    const depositData = {
      url: "https://anchor.example.com/deposit/123",
      id: "tx-123",
    };
    mockFetch.mockResolvedValueOnce(createMockResponse(depositData));

    const result = await anchorService.startInteractive({
      transferServer: "https://anchor.example.com/transfer",
      token: "jwt-token",
      kind: "deposit",
      assetCode: "USDC",
      account: "GCXXXXXXX",
    });

    expect(result.url).toBe("https://anchor.example.com/deposit/123");
    expect(result.id).toBe("tx-123");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://anchor.example.com/transfer/transactions/deposit/interactive",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("starts a withdrawal transaction", async () => {
    const withdrawData = {
      url: "https://anchor.example.com/withdraw/456",
      id: "tx-456",
    };
    mockFetch.mockResolvedValueOnce(createMockResponse(withdrawData));

    const result = await anchorService.startInteractive({
      transferServer: "https://anchor.example.com/transfer",
      token: "jwt-token",
      kind: "withdrawal",
      assetCode: "XLM",
      account: "GCXXXXXXX",
    });

    expect(result.url).toBe("https://anchor.example.com/withdraw/456");
    expect(result.id).toBe("tx-456");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://anchor.example.com/transfer/transactions/withdraw/interactive",
      expect.objectContaining({ method: "POST" })
    );
  });
});

describe("Anchor Service - Transaction Status Polling", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("returns transaction status", async () => {
    const txData = { transaction: { status: "completed" } };
    mockFetch.mockResolvedValueOnce(createMockResponse(txData));

    const result = await anchorService.getTransactionStatus({
      transferServer: "https://anchor.example.com/transfer",
      token: "jwt-token",
      id: "tx-123",
    });

    expect(result).toBe("completed");
    expect(mockFetch).toHaveBeenCalledWith(
      "https://anchor.example.com/transfer/transaction?id=tx-123",
      { headers: { Authorization: "Bearer jwt-token" } }
    );
  });

  it("returns null on status fetch failure", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse("Not Found", 404, "Not Found")
    );

    const result = await anchorService.getTransactionStatus({
      transferServer: "https://anchor.example.com/transfer",
      token: "jwt-token",
      id: "invalid-tx",
    });

    expect(result).toBeNull();
  });

  it("returns null when transaction field is missing", async () => {
    mockFetch.mockResolvedValueOnce(createMockResponse({}));

    const result = await anchorService.getTransactionStatus({
      transferServer: "https://anchor.example.com/transfer",
      token: "jwt-token",
      id: "tx-123",
    });

    expect(result).toBeNull();
  });
});

describe("Anchor Service - Retry/Backoff Logic", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    anchorService.clearTomlCache();
  });

  it("retries on 5xx errors with backoff", async () => {
    // Fail twice, then succeed
    mockFetch
      .mockResolvedValueOnce(createMockResponse("Server Error", 500))
      .mockResolvedValueOnce(createMockResponse("Server Error", 502))
      .mockResolvedValueOnce(
        createMockResponse(`
          WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
          TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/transfer"
          SIGNING_KEY = "GCXXXXXXX"
        `)
      );

    const result = await anchorService.getToml("anchor.example.com");

    expect(result.webAuthEndpoint).toBe("https://anchor.example.com/auth");
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry on 4xx errors", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse("Bad Request", 400, "Bad Request")
    );

    await expect(
      anchorService.getToml("anchor.example.com")
    ).rejects.toThrow(Errors.upstream("").constructor);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on 401 Unauthorized", async () => {
    mockFetch.mockResolvedValueOnce(
      createMockResponse("Unauthorized", 401, "Unauthorized")
    );

    await expect(
      anchorService.getToml("anchor.example.com")
    ).rejects.toThrow(Errors.upstream("").constructor);

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("retries up to max retries on persistent 5xx", async () => {
    // Exhaust all retries
    mockFetch
      .mockResolvedValueOnce(createMockResponse("Error", 500))
      .mockResolvedValueOnce(createMockResponse("Error", 502))
      .mockResolvedValueOnce(createMockResponse("Error", 503))
      .mockResolvedValueOnce(
        createMockResponse(`
          WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
          TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/transfer"
          SIGNING_KEY = "GCXXXXXXX"
        `)
      );

    const result = await anchorService.getToml("anchor.example.com");

    expect(result.webAuthEndpoint).toBe("https://anchor.example.com/auth");
    // 3 retries (1 initial + 3 retries = 4 total)
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});

describe("Anchor Service - Session Happy Path (Deposit)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    anchorService.clearTomlCache();
  });

  it("completes a full deposit session flow", async () => {
    // Step 1: Get TOML
    mockFetch.mockResolvedValueOnce(
      createMockResponse(`
        WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
        TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/transfer"
        SIGNING_KEY = "GCXXXXXXX"
      `)
    );

    // Step 2: Get SEP-10 Challenge
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        transaction: "CHALLENGEXDR",
        network_passphrase: "Test SDF Network ; September 2015",
      })
    );

    // Step 3: Get Token (simulate signing the challenge)
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ token: "jwt-token-12345" })
    );

    // Step 4: Start interactive deposit
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        url: "https://anchor.example.com/deposit/abc123",
        id: "deposit-123",
      })
    );

    // Step 5: Poll status (completed)
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ transaction: { status: "completed" } })
    );

    // Execute session flow
    const toml = await anchorService.getToml("anchor.example.com");
    expect(toml.webAuthEndpoint).toBe("https://anchor.example.com/auth");

    const challenge = await anchorService.getChallenge(
      toml.webAuthEndpoint,
      "GCXXXXXXX"
    );
    expect(challenge.transaction).toBe("CHALLENGEXDR");

    const token = await anchorService.getToken(
      toml.webAuthEndpoint,
      "SIGNEDCHALLENGE"
    );
    expect(token).toBe("jwt-token-12345");

    const session = await anchorService.startInteractive({
      transferServer: toml.transferServerSep24,
      token,
      kind: "deposit",
      assetCode: "USDC",
      account: "GCXXXXXXX",
    });
    expect(session.url).toBe("https://anchor.example.com/deposit/abc123");

    const status = await anchorService.getTransactionStatus({
      transferServer: toml.transferServerSep24,
      token,
      id: session.id,
    });
    expect(status).toBe("completed");

    // Verify all calls were made
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});

describe("Anchor Service - Session Happy Path (Withdrawal)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    anchorService.clearTomlCache();
  });

  it("completes a full withdrawal session flow", async () => {
    // Step 1: Get TOML
    mockFetch.mockResolvedValueOnce(
      createMockResponse(`
        WEB_AUTH_ENDPOINT = "https://anchor.example.com/auth"
        TRANSFER_SERVER_SEP0024 = "https://anchor.example.com/transfer"
        SIGNING_KEY = "GCXXXXXXX"
      `)
    );

    // Step 2: Get SEP-10 Challenge
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        transaction: "CHALLENGEXDR",
        network_passphrase: "Test SDF Network ; September 2015",
      })
    );

    // Step 3: Get Token
    mockFetch.mockResolvedValueOnce(
      createMockResponse({ token: "jwt-token-67890" })
    );

    // Step 4: Start interactive withdrawal
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        url: "https://anchor.example.com/withdraw/def456",
        id: "withdraw-456",
      })
    );

    // Step 5: Poll status (pending_user_transfer_start)
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        transaction: { status: "pending_user_transfer_start" },
      })
    );

    // Execute session flow
    const toml = await anchorService.getToml("anchor.example.com");

    const challenge = await anchorService.getChallenge(
      toml.webAuthEndpoint,
      "GCYYYYYYY"
    );

    const token = await anchorService.getToken(
      toml.webAuthEndpoint,
      "SIGNEDCHALLENGE2"
    );

    const session = await anchorService.startInteractive({
      transferServer: toml.transferServerSep24,
      token,
      kind: "withdrawal",
      assetCode: "USDC",
      account: "GCYYYYYYY",
    });
    expect(session.url).toBe("https://anchor.example.com/withdraw/def456");

    const status = await anchorService.getTransactionStatus({
      transferServer: toml.transferServerSep24,
      token,
      id: session.id,
    });
    expect(status).toBe("pending_user_transfer_start");

    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});
