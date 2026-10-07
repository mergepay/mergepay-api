import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";

describe("Auth Rate Limiting", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("should trigger HTTP 429 and expected headers when threshold exceeded on /auth/challenge", async () => {
    // The default max is 15. We send 16 requests.
    const max = 15;
    
    // Using a valid dummy public key format (32 bytes base32 encoded starting with G).
    // GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF
    const validPubKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/auth/challenge",
        payload: { account: validPubKey },
        headers: { "x-forwarded-for": "192.168.1.100" }
      });
      expect(res.statusCode).not.toBe(429);
    }

    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: validPubKey },
      headers: { "x-forwarded-for": "192.168.1.100" }
    });

    if (res.statusCode === 500) {
      console.log(res.json());
    }
    expect(res.statusCode).toBe(429);
    
    // Check standard rate limit headers
    expect(res.headers["x-ratelimit-limit"]).toBe("15");
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();

    // Check JSON schema
    const body = res.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.message).toBe("Too many requests, slow down.");
  });
});
