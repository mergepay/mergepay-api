import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorService } from "../src/services/anchor";
import { TimeoutError } from "../src/services/timeout";

// The anchor service is the only module that issues anchor HTTP requests, so
// stubbing global fetch is enough to exercise it end to end with no network.
const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

const VALID_TOML = `
WEB_AUTH_ENDPOINT = "https://anchor.example/auth"
TRANSFER_SERVER_SEP0024 = "https://anchor.example/sep24"
SIGNING_KEY = "GSIGNINGKEY"

[[CURRENCIES]]
code = "USDC"
issuer = "GISSUER"
`;

// Each test uses its own domain / transfer server so the toml cache and the
// per-provider circuit breaker never leak state between tests.
let n = 0;
const unique = (prefix: string) => `${prefix}-${++n}.example`;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anchorService.getToml", () => {
  it("parses the SEP-24 fields and currencies", async () => {
    const domain = unique("toml");
    fetchMock.mockResolvedValue(textResponse(VALID_TOML));

    const toml = await anchorService.getToml(domain);

    expect(fetchMock).toHaveBeenCalledWith(
      `https://${domain}/.well-known/stellar.toml`,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(toml).toEqual({
      homeDomain: domain,
      webAuthEndpoint: "https://anchor.example/auth",
      transferServerSep24: "https://anchor.example/sep24",
      signingKey: "GSIGNINGKEY",
      assets: [{ code: "USDC", issuer: "GISSUER" }],
    });
  });

  it("serves a cached toml without a second request", async () => {
    const domain = unique("toml");
    fetchMock.mockResolvedValue(textResponse(VALID_TOML));

    await anchorService.getToml(domain);
    await anchorService.getToml(domain);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a non-OK response as upstream", async () => {
    fetchMock.mockResolvedValue(textResponse("nope", 500));
    await expect(anchorService.getToml(unique("toml"))).rejects.toMatchObject({
      code: "UPSTREAM_ERROR",
    });
  });

  it("rejects a toml missing required SEP-24 fields", async () => {
    fetchMock.mockResolvedValue(textResponse(`SIGNING_KEY = "GKEY"`));
    await expect(anchorService.getToml(unique("toml"))).rejects.toMatchObject({
      message: expect.stringContaining("missing required SEP-24 fields"),
    });
  });

  it("rejects an unparseable toml", async () => {
    fetchMock.mockResolvedValue(textResponse("this is = = not toml"));
    await expect(anchorService.getToml(unique("toml"))).rejects.toMatchObject({
      message: "Anchor returned invalid stellar.toml",
    });
  });

  it("stops calling an anchor once its circuit opens", async () => {
    const domain = unique("toml");
    fetchMock.mockResolvedValue(textResponse("down", 503));

    for (let i = 0; i < 10; i++) {
      await anchorService.getToml(domain).catch(() => {});
    }
    const callsWhenOpen = fetchMock.mock.calls.length;
    await expect(anchorService.getToml(domain)).rejects.toMatchObject({
      message: expect.stringContaining("Circuit open"),
    });
    expect(fetchMock.mock.calls.length).toBe(callsWhenOpen);
  });
});

describe("anchorService SEP-10 / SEP-24 calls", () => {
  it("getChallenge defaults the passphrase when the anchor omits it", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ transaction: "AAAA" }));

    const challenge = await anchorService.getChallenge("https://anchor.example/auth", "GACCOUNT");

    expect(fetchMock.mock.calls[0][0]).toBe("https://anchor.example/auth?account=GACCOUNT");
    expect(challenge.transaction).toBe("AAAA");
    expect(typeof challenge.networkPassphrase).toBe("string");
  });

  it("getToken rejects a response without a token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ jwt: "wrong-field" }));
    await expect(
      anchorService.getToken("https://anchor.example/auth", "SIGNED")
    ).rejects.toMatchObject({ message: "Anchor returned an unexpected response format" });
  });

  it("startInteractive posts to the withdraw endpoint with the bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ url: "https://anchor.example/flow", id: "tx1" }));

    const result = await anchorService.startInteractive({
      transferServer: "https://anchor.example/sep24",
      token: "jwt",
      kind: "withdrawal",
      assetCode: "USDC",
      account: "GACCOUNT",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://anchor.example/sep24/transactions/withdraw/interactive");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer jwt");
    expect(result).toEqual({ url: "https://anchor.example/flow", id: "tx1" });
  });

  it("propagates a timeout as a TimeoutError", async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    await expect(
      anchorService.getChallenge("https://anchor.example/auth", "GACCOUNT")
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe("anchorService.pollTransaction", () => {
  const poll = (transferServer: string) =>
    anchorService.pollTransaction({ transferServer, token: "jwt", id: "tx1" });

  it("normalizes a completed transaction", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        transaction: {
          id: "tx1",
          status: "completed",
          amount_in: "10",
          amount_out: "9.5",
          amount_fee: "0.5",
          stellar_transaction_hash: "abc",
        },
      })
    );

    const result = await poll(`https://${unique("poll")}`);

    expect(result).toMatchObject({
      rawStatus: "completed",
      status: "completed",
      isError: false,
      amountIn: "10",
      amountOut: "9.5",
      amountFee: "0.5",
      stellarTransactionHash: "abc",
    });
  });

  it("maps an unknown anchor status to pending_anchor", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ transaction: { status: "brand_new_state" } }));
    const result = await poll(`https://${unique("poll")}`);
    expect(result).toMatchObject({ rawStatus: "brand_new_state", status: "pending_anchor", isError: false });
  });

  it.each([
    ["an HTTP error", () => jsonResponse({}, 502), "Anchor returned HTTP 502"],
    ["non-JSON", () => textResponse("<html>"), "malformed (non-JSON)"],
    ["no transaction field", () => jsonResponse({ ok: true }), "missing 'transaction' field"],
    ["no status", () => jsonResponse({ transaction: { id: "tx1" } }), "missing transaction status"],
  ])("returns a non-terminal error result for %s", async (_label, response, message) => {
    fetchMock.mockResolvedValue(response());
    const result = await poll(`https://${unique("poll")}`);
    expect(result.isError).toBe(true);
    expect(result.status).toBe("pending_anchor");
    expect(result.message).toContain(message);
  });

  it("returns an error result instead of throwing on transport failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await poll(`https://${unique("poll")}`);
    expect(result).toMatchObject({ isError: true, status: "pending_anchor" });
    expect(result.message).toContain("ECONNREFUSED");
  });
});
