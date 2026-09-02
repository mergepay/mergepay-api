import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Horizon, Asset, BASE_FEE, Keypair, Operation, TransactionBuilder, Account } from "@stellar/stellar-sdk";

vi.mock("../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    group: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn() },
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

import { buildApp } from "../src/app";
import { config } from "../src/config";
import { anchorService } from "../src/services/anchor";
import { stellar } from "../src/services/stellar";
import { TimeoutError, TransportError, toProviderError } from "../src/services/timeout";
import { classifyJobFailure } from "../src/services/job-retry";
import { ProviderError } from "../src/lib/provider-error";
import { Errors } from "../src/lib/errors";

// ─── helpers ─────────────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function nonJsonResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new SyntaxError("Unexpected token < in JSON");
    },
  } as unknown as Response;
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), {
    name: "AbortError",
  });
}

// ─── toProviderError mapping ────────────────────────────────────────────────

describe("toProviderError", () => {
  const ctx = {
    provider: "horizon",
    operation: "Horizon.test",
    fallbackMessage: "Provider call failed",
  };

  it("maps TimeoutError to the timeout category", () => {
    const err = toProviderError(new TimeoutError("Horizon.test", 1000), ctx);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).category).toBe("timeout");
    expect(err.status).toBe(502);
    expect(err.code).toBe("UPSTREAM_ERROR");
  });

  it("maps TransportError to the transport category", () => {
    const err = toProviderError(new TransportError("Horizon.test", "ECONNREFUSED"), ctx);
    expect((err as ProviderError).category).toBe("transport");
  });

  it("maps Horizon result codes to a permanent rejection, preserving only safe identifiers", () => {
    const sdkError = {
      response: {
        status: 400,
        data: { extras: { result_codes: { transaction: "tx_bad_seq", operations: ["op_underfunded"] } } },
      },
    };
    const err = toProviderError(sdkError, ctx) as ProviderError;
    expect(err.category).toBe("rejected");
    expect(err.code).toBe("PROVIDER_REJECTED");
    expect(err.message).toContain("tx_bad_seq");
    expect(err.message).toContain("op_underfunded");
    // The raw upstream payload must never leak into the client-facing message.
    expect(err.message).not.toContain("response");
    expect(err.message).not.toContain("extras");
  });

  it("maps upstream 429 to rate_limited", () => {
    const err = toProviderError({ response: { status: 429, data: {} } }, ctx) as ProviderError;
    expect(err.category).toBe("rate_limited");
    expect(err.retryable).toBe(true);
  });

  it("maps upstream 5xx to unavailable", () => {
    const err = toProviderError({ response: { status: 503, data: {} } }, ctx) as ProviderError;
    expect(err.category).toBe("unavailable");
  });

  it("never copies an unknown error's message into the client-facing text", () => {
    const err = toProviderError(
      new Error("raw upstream dump: bearer abc.def.ghi signed XDR AAAA"),
      ctx
    );
    expect(err.message).toBe("Provider call failed");
    expect(err.message).not.toContain("bearer");
    expect(err.message).not.toContain("AAAA");
  });

  it("passes intentional AppErrors through unchanged", () => {
    const original = Errors.badRequest("xdr_mismatch", "bad envelope");
    expect(toProviderError(original, ctx)).toBe(original);
  });
});

// ─── worker retry classification of provider failures ───────────────────────

describe("classifyJobFailure with ProviderError", () => {
  function providerError(category: ProviderError["category"]): ProviderError {
    return new ProviderError({
      category,
      provider: "anchor",
      operation: "Anchor.pollTransaction",
      message: "failed",
    });
  }

  it("treats timeouts as indeterminate (ledger check required)", () => {
    expect(classifyJobFailure(providerError("timeout"))).toBe("indeterminate");
  });

  it("treats rate limits and outages as transient", () => {
    expect(classifyJobFailure(providerError("rate_limited"))).toBe("transient");
    expect(classifyJobFailure(providerError("transport"))).toBe("transient");
    expect(classifyJobFailure(providerError("unavailable"))).toBe("transient");
    expect(classifyJobFailure(providerError("malformed"))).toBe("transient");
  });

  it("treats rejections as permanent", () => {
    expect(classifyJobFailure(providerError("rejected"))).toBe("permanent");
  });
});

// ─── anchor service over a mocked fetch ─────────────────────────────────────

describe("anchorService structured errors (mocked fetch)", () => {
  const fetchMock = vi.fn();

  beforeAll(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("returns the successful challenge shape unchanged", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ transaction: "signed-challenge-xdr", network_passphrase: "Test Net" })
    );
    const result = await anchorService.getChallenge(
      "https://anchor.example/auth",
      config.ANCHOR_HOME_DOMAIN
    );
    expect(result.transaction).toBe("signed-challenge-xdr");
    expect(result.networkPassphrase).toBe("Test Net");
  });

  it("converts a timeout into a categorized ProviderError without leaking the URL", async () => {
    fetchMock.mockRejectedValueOnce(abortError());
    await expect(
      anchorService.getChallenge("https://secret-anchor.example/auth", "GA")
    ).rejects.toMatchObject({
      name: "ProviderError",
      category: "timeout",
      code: "UPSTREAM_ERROR",
      status: 502,
    });
    try {
      await anchorService.getChallenge("https://secret-anchor.example/auth", "GA");
    } catch (err: any) {
      expect(String(err.message)).not.toContain("secret-anchor.example");
    }
  });

  it("classifies a non-success HTTP status as unavailable", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(anchorService.getChallenge("https://anchor.example/auth", "GA")).rejects.toMatchObject({
      category: "unavailable",
      code: "UPSTREAM_ERROR",
      status: 502,
    });
  });

  it("retains rate-limit information for retry decisions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));
    await expect(
      anchorService.getToken("https://anchor.example/auth", "SIGNED_XDR")
    ).rejects.toMatchObject({ category: "rate_limited", retryable: true });
  });

  it("classifies a malformed non-JSON body without throwing untyped values", async () => {
    fetchMock.mockResolvedValueOnce(nonJsonResponse());
    await expect(
      anchorService.startInteractive({
        transferServer: "https://anchor.example",
        token: "tok",
        kind: "withdrawal",
        assetCode: "USDC",
        account: "GA",
      })
    ).rejects.toMatchObject({ category: "malformed", code: "UPSTREAM_ERROR" });
  });

  it("classifies a well-formed JSON body with an unexpected schema as malformed", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ unexpected: true }));
    await expect(anchorService.getChallenge("https://anchor.example/auth", "GA")).rejects.toMatchObject({
      category: "malformed",
    });
  });
});

// ─── Horizon submission rejection ────────────────────────────────────────────

describe("stellar submission rejection (mocked Horizon)", () => {
  it("surfaces a typed rejection carrying only result-code identifiers", async () => {
    const source = new Account(Keypair.random().publicKey(), "0");
    const tx = new TransactionBuilder(source, {
      fee: String(Number(BASE_FEE) * 2),
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: "1",
        })
      )
      .setTimeout(30)
      .build();

    const submitSpy = vi
      .spyOn(Horizon.Server.prototype, "submitTransaction")
      .mockRejectedValue({
        response: {
          status: 400,
          data: { extras: { result_codes: { transaction: "tx_bad_seq" } } },
        },
      });

    await expect(stellar.submitSigned(tx.toXDR())).rejects.toMatchObject({
      name: "ProviderError",
      category: "rejected",
      code: "PROVIDER_REJECTED",
    });

    try {
      await stellar.submitSigned(tx.toXDR());
    } catch (err: any) {
      expect(err.message).toContain("Stellar rejected the transaction");
      expect(err.message).toContain("tx_bad_seq");
      expect(classifyJobFailure(err)).toBe("permanent");
      expect(JSON.stringify(err.message)).not.toContain("AAAA");
    }

    submitSpy.mockRestore();
  });
});

// ─── route-level behavior through the central error handler ─────────────────

describe("route-level provider failure responses", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp();
    app.get("/test/provider-timeout", async () => {
      throw new TimeoutError("Horizon.loadAccount", 3000);
    });
    app.get("/test/provider-transport", async () => {
      throw new TransportError("Horizon.loadAccount", "ECONNREFUSED");
    });
    app.get("/test/provider-rejected", async () => {
      throw new ProviderError({
        category: "rejected",
        provider: "horizon",
        operation: "Horizon.submitTransaction",
        message: "Stellar rejected the transaction",
        detail: ["tx_bad_seq"],
      });
    });
    app.get("/test/unexpected", async () => {
      throw new TypeError("Cannot read properties of undefined");
    });
  });

  it("answers an escaping timeout with a safe 502 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/test/provider-timeout" });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.code).toBe("UPSTREAM_ERROR");
    expect(body.message).not.toContain("Horizon.loadAccount");
    expect(body.requestId).toBeTruthy();
  });

  it("answers an escaping transport failure with a safe 502 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/test/provider-transport" });
    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("UPSTREAM_ERROR");
  });

  it("distinguishes a provider rejection by its machine-readable code", async () => {
    const res = await app.inject({ method: "GET", url: "/test/provider-rejected" });
    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.code).toBe("PROVIDER_REJECTED");
    expect(body.message).toBe("Stellar rejected the transaction: tx_bad_seq");
    expect(body.error).toBe("PROVIDER_REJECTED");
  });

  it("keeps unexpected errors on the generic internal-error path", async () => {
    const res = await app.inject({ method: "GET", url: "/test/unexpected" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.message).toBe("Something went wrong.");
    expect(JSON.stringify(body)).not.toContain("TypeError");
  });
});
