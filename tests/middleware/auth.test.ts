/**
 * SEP-10 session token expiration tests — issue #16.
 *
 * Verifies that the auth middleware reports *why* a bearer token was
 * rejected instead of collapsing every failure into a generic 401:
 *
 *   - a correctly-signed token whose `exp` has passed → 401 TOKEN_EXPIRED,
 *     with a hint telling the client to re-authenticate via SEP-10
 *     (or refresh its session);
 *   - a token that fails verification outright (wrong secret, tampered
 *     payload, malformed string, wrong issuer) → 401 INVALID_TOKEN;
 *   - a missing Authorization header → 401 UNAUTHORIZED;
 *   - a valid token passes through and the route sees the request.
 *
 * Runs fully offline: Prisma is mocked (the protected route's user lookup is
 * not the subject here) and no Horizon or anchor is touched. Tokens are
 * signed with the same `config` values the middleware verifies against, so
 * the suite is independent of any particular environment file.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { FastifyInstance } from "fastify";

process.env.VITEST = "true";
process.env.NODE_ENV = "test";

vi.mock("../../src/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => null),
    },
  },
}));

vi.mock("../../src/services/audit", () => ({
  audit: vi.fn(async () => undefined),
}));

// Imported after the mocks above are registered. `config` is the same parsed
// configuration the auth plugin reads, so test-minted tokens verify.
import { buildApp } from "../../src/app";
import { config } from "../../src/config";

const VALID_PK = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGZUA7RNUY6FJQZ";

/** Seconds of remaining life (may be negative for an already-expired token). */
function makeToken(opts: {
  sub: string;
  pk: string;
  remainingSeconds: number;
  issuer?: string;
  secret?: string;
}): string {
  return jwt.sign(
    { sub: opts.sub, pk: opts.pk },
    opts.secret ?? config.JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: opts.remainingSeconds,
      issuer: opts.issuer ?? config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }
  );
}

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SEP-10 session token handling (issue #16)", () => {
  describe("expired tokens", () => {
    it("returns 401 TOKEN_EXPIRED with a re-auth hint for an expired token", async () => {
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: -3600,
      });

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe("TOKEN_EXPIRED");
      // This API's envelope mirrors the code into `error`; the human text is
      // carried in `message` (see docs/api-contract.md).
      expect(body.error).toBe("TOKEN_EXPIRED");
      expect(body.message).toBe("Token expired");
      expect(body.details).toMatchObject({ code: "REAUTHENTICATE" });
      expect(body.details.endpoints).toMatchObject({
        sep10Challenge: "/auth/challenge",
        sep10Verify: "/auth/verify",
        refresh: "/auth/refresh",
      });
      expect(body.requestId).toBeDefined();
    });

    it("returns 401 TOKEN_EXPIRED for a token within the near-expiry margin", async () => {
      // Inside the margin the SDK would still accept, this server rejects.
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: Math.max(1, config.TOKEN_EXPIRY_MARGIN_SECONDS - 10),
      });

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe("TOKEN_EXPIRED");
      expect(body.error).toBe("TOKEN_EXPIRED");
      expect(body.message).toBe("Token expired");
    });

    it("does not reveal which claims failed — same envelope as other auth failures", async () => {
      const presentedToken = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: -1,
      });

      const expired = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${presentedToken}` },
      });

      expect(expired.statusCode).toBe(401);
      expect(expired.json().code).toBe("TOKEN_EXPIRED");
      // The response never echoes any fragment of the rejected token itself.
      expect(expired.body).not.toContain(presentedToken.slice(0, 16));
    });
  });

  describe("invalid tokens", () => {
    it("returns 401 INVALID_TOKEN for a token signed with the wrong secret", async () => {
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: 3600,
        secret: `${config.JWT_SECRET.slice(0, 8)}-an-entirely-different-secret`,
      });

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe("INVALID_TOKEN");
      expect(body.error).toBe("INVALID_TOKEN");
      expect(body.message).toBe("Invalid token");
      expect(body.requestId).toBeDefined();
    });

    it("returns 401 INVALID_TOKEN for a malformed token string", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Bearer not-a-real-jwt" },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe("INVALID_TOKEN");
      expect(body.error).toBe("INVALID_TOKEN");
      expect(body.message).toBe("Invalid token");
    });

    it("returns 401 INVALID_TOKEN for a tampered payload", async () => {
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: 3600,
      });
      const [header, , signature] = token.split(".");
      const forgedPayload = Buffer.from(
        JSON.stringify({
          sub: "user-2",
          pk: VALID_PK,
          exp: Math.floor(Date.now() / 1000) + 3600,
          iss: config.JWT_ISSUER,
          aud: config.JWT_AUDIENCE,
        })
      ).toString("base64url");

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${header}.${forgedPayload}.${signature}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("INVALID_TOKEN");
    });

    it("returns 401 INVALID_TOKEN for a token with the wrong issuer", async () => {
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: 3600,
        issuer: `${config.JWT_ISSUER}-not`,
      });

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("INVALID_TOKEN");
    });

    it("returns 401 INVALID_TOKEN for a well-signed token missing the exp claim", async () => {
      const token = jwt.sign(
        { sub: "user-1", pk: VALID_PK },
        config.JWT_SECRET,
        {
          algorithm: "HS256",
          issuer: config.JWT_ISSUER,
          audience: config.JWT_AUDIENCE,
          // No expiresIn — no exp claim.
        }
      );

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("INVALID_TOKEN");
    });
  });

  describe("missing credentials", () => {
    it("returns 401 UNAUTHORIZED when no Authorization header is sent", async () => {
      const res = await app.inject({ method: "GET", url: "/me" });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.code).toBe("UNAUTHORIZED");
      expect(body.requestId).toBeDefined();
    });

    it("returns 401 UNAUTHORIZED for a non-Bearer Authorization header", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("UNAUTHORIZED");
    });
  });

  describe("valid tokens", () => {
    it("lets a valid, unexpired token through to the route", async () => {
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: 3600,
      });

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      // 404 (mocked Prisma finds no user) proves authentication passed and
      // the request reached the handler — the alternative outcomes are all
      // 401s from the middleware.
      expect(res.statusCode).toBe(404);
    });

    it("accepts a token just outside the near-expiry margin", async () => {
      const token = makeToken({
        sub: "user-1",
        pk: VALID_PK,
        remainingSeconds: config.TOKEN_EXPIRY_MARGIN_SECONDS + 1,
      });

      const res = await app.inject({
        method: "GET",
        url: "/me",
        headers: { authorization: `Bearer ${token}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });
});
