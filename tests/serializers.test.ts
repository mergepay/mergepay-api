import { describe, it, expect } from "vitest";

import {
  reqSerializer,
  resSerializer,
  txHashSerializer,
  isStellarTxHash,
  truncateStellarTxHash,
  stellarTxHashSerializers,
  STELLAR_TX_HASH_HEX_LENGTH,
  MISSING_TX_HASH,
  INVALID_TX_HASH,
  type SerializedRequest,
  type SerializedResponse,
} from "../src/lib/serializers";

/** A well-formed Stellar transaction hash: 64 lowercase hex characters. */
const VALID_TX_HASH =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";

// ─── reqSerializer ──────────────────────────────────────────────────────────

describe("reqSerializer", () => {
  it("redacts the authorization header", () => {
    const req = {
      method: "POST",
      url: "/auth/verify",
      headers: {
        authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.secret",
        "content-type": "application/json",
      },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers.authorization).toBe("[REDACTED]");
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("redacts the cookie header", () => {
    const req = {
      method: "GET",
      url: "/health",
      headers: {
        cookie: "session=abc123; token=xyz789",
        "user-agent": "Mozilla/5.0",
      },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers.cookie).toBe("[REDACTED]");
    expect(result.headers["user-agent"]).toBe("Mozilla/5.0");
  });

  it("preserves request ID headers", () => {
    const req = {
      method: "GET",
      url: "/api/data",
      headers: {
        "x-request-id": "req-abc123",
        "x-correlation-id": "corr-def456",
        authorization: "Bearer token",
      },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers["x-request-id"]).toBe("req-abc123");
    expect(result.headers["x-correlation-id"]).toBe("corr-def456");
    expect(result.headers.authorization).toBe("[REDACTED]");
  });

  it("preserves standard telemetry headers", () => {
    const req = {
      method: "POST",
      url: "/settlements",
      headers: {
        "user-agent": "MergepayWeb/1.0",
        accept: "application/json",
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers["user-agent"]).toBe("MergepayWeb/1.0");
    expect(result.headers.accept).toBe("application/json");
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers.authorization).toBe("[REDACTED]");
  });

  it("copies query and params", () => {
    const req = {
      method: "GET",
      url: "/groups",
      headers: {},
      query: { page: "1", limit: "20" },
      params: { id: "group-123" },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.query).toEqual({ page: "1", limit: "20" });
    expect(result.params).toEqual({ id: "group-123" });
  });

  it("copies remote address info", () => {
    const req = {
      method: "GET",
      url: "/health",
      headers: {},
      remoteAddress: "127.0.0.1",
      remotePort: 54321,
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.remoteAddress).toBe("127.0.0.1");
    expect(result.remotePort).toBe(54321);
  });

  it("handles missing headers gracefully", () => {
    const req = {
      method: "GET",
      url: "/health",
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers).toEqual({});
    expect(result.method).toBe("GET");
    expect(result.url).toBe("/health");
  });

  it("handles null/undefined input", () => {
    expect(reqSerializer(null)).toEqual({
      method: "UNKNOWN",
      url: "UNKNOWN",
      headers: {},
    });
    expect(reqSerializer(undefined)).toEqual({
      method: "UNKNOWN",
      url: "UNKNOWN",
      headers: {},
    });
  });

  it("omits query/params/remoteAddress when not present", () => {
    const req = {
      method: "GET",
      url: "/health",
      headers: {},
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result).not.toHaveProperty("query");
    expect(result).not.toHaveProperty("params");
    expect(result).not.toHaveProperty("remoteAddress");
  });

  it("redacts authorization case-insensitively", () => {
    const req = {
      method: "GET",
      url: "/test",
      headers: {
        Authorization: "Bearer secret",
      },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers.Authorization).toBe("[REDACTED]");
  });

  it("keeps the request id so a logged request stays correlatable", () => {
    const req = {
      id: "req-abc123",
      method: "GET",
      url: "/health",
      headers: {},
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.id).toBe("req-abc123");
  });

  it("redacts the whole authorization family and API-key headers", () => {
    const req = {
      method: "GET",
      url: "/proxy",
      headers: {
        authorization: "Bearer secret",
        "proxy-authorization": "Basic cHJveHk6c2VjcmV0",
        "x-api-key": "key-123",
        "content-type": "application/json",
      },
    };

    const result: SerializedRequest = reqSerializer(req);
    expect(result.headers.authorization).toBe("[REDACTED]");
    expect(result.headers["proxy-authorization"]).toBe("[REDACTED]");
    expect(result.headers["x-api-key"]).toBe("[REDACTED]");
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("scrubs credential-shaped keys from the query", () => {
    const req = {
      method: "GET",
      url: "/callback",
      headers: {},
      query: { token: "s3cr3t", access_token: "also-s3cr3t", page: "1" },
    };

    const result: SerializedRequest = reqSerializer(req);
    // camelCase and snake_case spellings of the same credential both match.
    expect(result.query).toEqual({
      token: "[REDACTED]",
      access_token: "[REDACTED]",
      page: "1",
    });
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("redacts credential-shaped parameters in the URL itself", () => {
    // The query string is logged a second time inside `url`, so scrubbing
    // `req.query` alone would leave the token one field over.
    const result: SerializedRequest = reqSerializer({
      method: "GET",
      url: "/auth/callback?code=abc&access_token=s3cr3t&x-api-key=k-1&page=2",
      headers: {},
    });

    expect(result.url).toBe(
      "/auth/callback?code=abc&access_token=[REDACTED]&x-api-key=[REDACTED]&page=2"
    );
    expect(result.url).not.toContain("s3cr3t");
  });

  it("leaves a URL without credentials untouched", () => {
    expect(
      reqSerializer({ method: "GET", url: "/health/live", headers: {} }).url
    ).toBe("/health/live");
    expect(
      reqSerializer({ method: "GET", url: "/health/live?probe=1", headers: {} }).url
    ).toBe("/health/live?probe=1");
  });

  it("never lets circular query, params, or header values reach JSON.stringify", () => {
    const circular: Record<string, unknown> = { page: "1" };
    circular.self = circular;
    const headerBag: Record<string, unknown> = { "user-agent": "ua" };
    headerBag.loop = headerBag;

    const result: SerializedRequest = reqSerializer({
      method: "GET",
      url: "/groups",
      headers: headerBag,
      query: circular,
      params: circular,
    });

    let json = "";
    expect(() => {
      json = JSON.stringify(result);
    }).not.toThrow();
    expect(json).toContain("[CIRCULAR]");
    expect(result.headers["user-agent"]).toBe("ua");
    expect(result.query).toMatchObject({ page: "1", self: "[CIRCULAR]" });
    expect(result.params).toMatchObject({ page: "1", self: "[CIRCULAR]" });
  });

  it("coerces non-string method/url and non-numeric port instead of copying objects", () => {
    const result: SerializedRequest = reqSerializer({
      method: { verb: "GET" },
      url: ["a", "b"],
      headers: {},
      remoteAddress: 12345,
      remotePort: { port: 1 },
    });

    expect(result.method).toBe("UNKNOWN");
    expect(result.url).toBe("UNKNOWN");
    expect(result).not.toHaveProperty("remoteAddress");
    expect(result).not.toHaveProperty("remotePort");
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});

// ─── resSerializer ──────────────────────────────────────────────────────────

describe("resSerializer", () => {
  it("redacts the set-cookie header", () => {
    const res = {
      statusCode: 200,
      headers: {
        "set-cookie": "session=abc123; HttpOnly; Secure",
        "content-type": "application/json",
      },
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.headers["set-cookie"]).toBe("[REDACTED]");
    expect(result.headers["content-type"]).toBe("application/json");
  });

  it("preserves status code", () => {
    const res = {
      statusCode: 401,
      headers: {},
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.statusCode).toBe(401);
  });

  it("preserves non-sensitive response headers", () => {
    const res = {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-abc123",
        "x-ratelimit-limit": "100",
        "x-ratelimit-remaining": "99",
      },
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.headers["content-type"]).toBe("application/json");
    expect(result.headers["x-request-id"]).toBe("req-abc123");
    expect(result.headers["x-ratelimit-limit"]).toBe("100");
    expect(result.headers["x-ratelimit-remaining"]).toBe("99");
  });

  it("handles missing headers gracefully", () => {
    const res = {
      statusCode: 204,
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.headers).toEqual({});
    expect(result.statusCode).toBe(204);
  });

  it("handles null/undefined input", () => {
    expect(resSerializer(null)).toEqual({ statusCode: 0, headers: {} });
    expect(resSerializer(undefined)).toEqual({ statusCode: 0, headers: {} });
  });

  it("defaults statusCode to 0 when not a number", () => {
    const res = {
      statusCode: "oops",
      headers: {},
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.statusCode).toBe(0);
  });

  it("redacts set-cookie case-insensitively", () => {
    const res = {
      statusCode: 200,
      headers: {
        "Set-Cookie": "session=abc123",
      },
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.headers["Set-Cookie"]).toBe("[REDACTED]");
  });

  it("reads headers from a Fastify reply, which exposes them via getHeaders()", () => {
    // Pino hands the serializer the reply itself, not a Node response: a reply
    // has no `headers` property, so without this the set-cookie on the wire
    // would never even be seen, let alone redacted.
    const res = {
      statusCode: 201,
      getHeaders: () => ({
        "set-cookie": ["session=abc123; HttpOnly"],
        "content-type": "application/json; charset=utf-8",
      }),
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.statusCode).toBe(201);
    expect(result.headers["set-cookie"]).toBe("[REDACTED]");
    expect(result.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("survives a getHeaders() that throws", () => {
    const res = {
      statusCode: 500,
      getHeaders: () => {
        throw new Error("socket is gone");
      },
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.statusCode).toBe(500);
    expect(result.headers).toEqual({});
  });

  it("redacts the authorization family on the way out too", () => {
    const res = {
      statusCode: 401,
      headers: {
        "proxy-authorization": "Basic cHJveHk6c2VjcmV0",
        "x-api-key": "key-123",
        "www-authenticate": "Bearer",
      },
    };

    const result: SerializedResponse = resSerializer(res);
    expect(result.headers["proxy-authorization"]).toBe("[REDACTED]");
    expect(result.headers["x-api-key"]).toBe("[REDACTED]");
    expect(result.headers["www-authenticate"]).toBe("Bearer");
  });

  it("never lets a circular header value reach JSON.stringify", () => {
    const headerBag: Record<string, unknown> = { "content-type": "application/json" };
    headerBag.loop = headerBag;

    const result: SerializedResponse = resSerializer({ statusCode: 200, headers: headerBag });

    let json = "";
    expect(() => {
      json = JSON.stringify(result);
    }).not.toThrow();
    expect(json).toContain("[CIRCULAR]");
    expect(result.headers["content-type"]).toBe("application/json");
  });
});

// ─── txHashSerializer ───────────────────────────────────────────────────────

describe("txHashSerializer", () => {
  it("shortens a well-formed hash to head…tail", () => {
    expect(txHashSerializer(VALID_TX_HASH)).toBe("a1b2c3d4…ddeeff00");
  });

  it("normalizes uppercase hex to lowercase", () => {
    expect(txHashSerializer(VALID_TX_HASH.toUpperCase())).toBe(
      "a1b2c3d4…ddeeff00"
    );
  });

  it("trims surrounding whitespace before serializing", () => {
    expect(txHashSerializer(`  ${VALID_TX_HASH}\n`)).toBe("a1b2c3d4…ddeeff00");
  });

  it("does not echo malformed values", () => {
    // Too short, non-hex, and wrong-length inputs all collapse to a sentinel.
    expect(txHashSerializer("deadbeef")).toBe(INVALID_TX_HASH);
    expect(txHashSerializer("z".repeat(STELLAR_TX_HASH_HEX_LENGTH))).toBe(
      INVALID_TX_HASH
    );
    expect(txHashSerializer(VALID_TX_HASH.slice(0, 63))).toBe(INVALID_TX_HASH);
  });

  it("handles non-string and nullish inputs without throwing", () => {
    expect(txHashSerializer(42)).toBe(INVALID_TX_HASH);
    expect(txHashSerializer({ hash: VALID_TX_HASH })).toBe(INVALID_TX_HASH);
    expect(txHashSerializer([])).toBe(INVALID_TX_HASH);
    expect(txHashSerializer(null)).toBe(MISSING_TX_HASH);
    expect(txHashSerializer(undefined)).toBe(MISSING_TX_HASH);
  });
});

// ─── isStellarTxHash ────────────────────────────────────────────────────────

describe("isStellarTxHash", () => {
  it("accepts 64-character hex in either case, with padding", () => {
    expect(isStellarTxHash(VALID_TX_HASH)).toBe(true);
    expect(isStellarTxHash(VALID_TX_HASH.toUpperCase())).toBe(true);
    expect(isStellarTxHash(` ${VALID_TX_HASH} `)).toBe(true);
  });

  it("rejects malformed and non-string values", () => {
    expect(isStellarTxHash(VALID_TX_HASH.slice(0, 63))).toBe(false);
    expect(isStellarTxHash(`${VALID_TX_HASH}a`)).toBe(false);
    expect(isStellarTxHash("not-a-hash")).toBe(false);
    expect(isStellarTxHash(null)).toBe(false);
    expect(isStellarTxHash(123)).toBe(false);
    expect(isStellarTxHash(undefined)).toBe(false);
  });
});

// ─── truncateStellarTxHash ──────────────────────────────────────────────────

describe("truncateStellarTxHash", () => {
  it("keeps the leading and trailing characters of a full hash", () => {
    expect(truncateStellarTxHash(VALID_TX_HASH)).toBe("a1b2c3d4…ddeeff00");
  });

  it("leaves short values untouched", () => {
    expect(truncateStellarTxHash("abc")).toBe("abc");
  });
});

// ─── stellarTxHashSerializers ───────────────────────────────────────────────

describe("stellarTxHashSerializers", () => {
  it("maps every known Stellar hash field to the serializer", () => {
    for (const key of [
      "txHash",
      "stellarTxHash",
      "intendedTxHash",
      "transactionHash",
      "stellarTransactionHash",
    ]) {
      expect(stellarTxHashSerializers[key]).toBe(txHashSerializer);
      expect(stellarTxHashSerializers[key](VALID_TX_HASH)).toBe(
        "a1b2c3d4…ddeeff00"
      );
    }
  });
});
