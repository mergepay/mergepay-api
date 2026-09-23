/**
 * Issue #16 — SEP-10 token expiration and refresh, handled gracefully.
 *
 * The session middleware (src/plugins/auth.ts) must not collapse every bad
 * credential into one opaque 401. A client needs to know whether its token
 * expired (re-authenticate via SEP-10, or exchange a refresh token) or was
 * never valid to begin with (stop sending it):
 *
 *   - expired / inside the expiry margin → 401 `TOKEN_EXPIRED` + a hint
 *   - malformed, wrong signature, wrong issuer/audience/algorithm,
 *     not-yet-valid, or missing claims → 401 `INVALID_TOKEN`
 *   - no Authorization header, or not a Bearer scheme → 401 `UNAUTHORIZED`
 *   - a valid token proceeds normally
 *
 * Unit tests cover `verifyToken` directly; route tests exercise the full
 * Fastify path (middleware → error handler → response body) against a
 * protected route.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn() },
    group: { findUnique: vi.fn(), create: vi.fn() },
    groupMember: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    expense: { findUnique: vi.fn() },
    settlement: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    treasuryTransaction: { findUnique: vi.fn() },
    anchorSession: { findUnique: vi.fn(), findMany: vi.fn(async () => []) },
    withdrawal: { findUnique: vi.fn() },
    invite: { findUnique: vi.fn() },
    invitation: { findUnique: vi.fn(), findFirst: vi.fn() },
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(h.prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";
import { signToken, verifyToken } from "../../src/plugins/auth";
import { config } from "../../src/config";
import { AppError } from "../../src/errors";

const prisma = h.prisma;

const USER_ID = "user_1";
const PUBLIC_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function fakeUser() {
  return {
    id: USER_ID,
    stellarPublicKey: PUBLIC_KEY,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

/** Sign with the real secret but arbitrary claims/options. */
function signWith(options: jwt.SignOptions, claims: Record<string, unknown> = {}) {
  return jwt.sign(
    { sub: USER_ID, pk: PUBLIC_KEY, ...claims },
    config.JWT_SECRET,
    {
      algorithm: "HS256",
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      ...options,
    }
  );
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(fakeUser());
});

describe("verifyToken — classification", () => {
  it("returns the session for a valid token", () => {
    const token = signToken({ id: USER_ID, stellarPublicKey: PUBLIC_KEY });
    expect(verifyToken(token)).toEqual({
      id: USER_ID,
      stellarPublicKey: PUBLIC_KEY,
    });
  });

  it("classifies an expired token as TOKEN_EXPIRED", () => {
    const token = signWith({ expiresIn: -10 });
    try {
      verifyToken(token);
      expect.unreachable("expired token must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      const err = error as AppError;
      expect(err.code).toBe("TOKEN_EXPIRED");
      expect(err.status).toBe(401);
      expect(err.message).toBe("Token expired");
    }
  });

  it("classifies a token inside the expiry margin as TOKEN_EXPIRED", () => {
    // Well within the 30s margin: still an expiry outcome for the client.
    const token = signWith({ expiresIn: 5 });
    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_EXPIRED" })
    );
  });

  it("classifies a token signed with the wrong secret as INVALID_TOKEN", () => {
    const forged = jwt.sign(
      { sub: USER_ID, pk: PUBLIC_KEY },
      "wrong-secret-entirely",
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: "15m",
      }
    );
    expect(() => verifyToken(forged)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("classifies a malformed token as INVALID_TOKEN", () => {
    expect(() => verifyToken("not-a-jwt")).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("classifies a token with the wrong issuer as INVALID_TOKEN", () => {
    const token = signWith({ issuer: "some-other-issuer" });
    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("classifies a token with the wrong audience as INVALID_TOKEN", () => {
    const token = signWith({ audience: "some-other-audience" });
    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("classifies a not-yet-valid token as INVALID_TOKEN", () => {
    const token = signWith({ notBefore: "10m", expiresIn: "15m" });
    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("classifies a token missing the session claims as INVALID_TOKEN", () => {
    const token = jwt.sign({}, config.JWT_SECRET, {
      algorithm: "HS256",
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      expiresIn: "15m",
    });
    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("never echoes the jsonwebtoken error text", () => {
    const token = signWith({ expiresIn: -10 });
    try {
      verifyToken(token);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/jwt expired/i);
    }
  });
});

describe("authenticated route — 401 contract", () => {
  it("lets a valid token through", async () => {
    const token = signToken({ id: USER_ID, stellarPublicKey: PUBLIC_KEY });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(USER_ID);
  });

  it("returns UNAUTHORIZED when no token is presented", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
    expect(res.json().error).toBe("UNAUTHORIZED");
  });

  it("returns UNAUTHORIZED when the Authorization header is not Bearer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Token xyz" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("UNAUTHORIZED");
  });

  it("returns TOKEN_EXPIRED with a re-authentication hint for an expired token", async () => {
    const token = signWith({ expiresIn: -10 });
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
    expect(body.requestId).toBeTruthy();
    // The hint names both recovery paths: a full SEP-10 re-authentication and
    // the refresh endpoint for clients already holding a refresh token.
    expect(body.details.hint).toMatch(/SEP-10/);
    expect(body.details.hint).toMatch(/\/auth\/refresh/);
  });

  it("returns TOKEN_EXPIRED for a token inside the expiry margin", async () => {
    const token = signWith({ expiresIn: 5 });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("TOKEN_EXPIRED");
  });

  // The issue's sketch writes `{ error: 'Token expired', code: 'TOKEN_EXPIRED' }`;
  // this API's error envelope mirrors the machine code into `error` everywhere
  // and carries the human phrase in `message` — kept consistent with every
  // other endpoint rather than introducing a second convention.
  it("returns INVALID_TOKEN for a token signed with the wrong secret", async () => {
    const forged = jwt.sign(
      { sub: USER_ID, pk: PUBLIC_KEY },
      "wrong-secret-entirely",
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: "15m",
      }
    );
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("INVALID_TOKEN");
    expect(body.code).toBe("INVALID_TOKEN");
    expect(body.message).toBe("Invalid token");
    expect(body.requestId).toBeTruthy();
    // An unverifiable credential is not recoverable by refreshing.
    expect(body.details?.hint).toBeUndefined();
  });

  it("returns INVALID_TOKEN for a malformed bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: "Bearer not-a-jwt" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("INVALID_TOKEN");
  });

  it("keeps the error envelope stack-free", async () => {
    const token = signWith({ expiresIn: -10 });
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json();
    expect(body.stack).toBeUndefined();
    expect(res.body).not.toMatch(/jwt/i);
  });

  it("codes TOKEN_EXPIRED and INVALID_TOKEN stay distinguishable", async () => {
    const expired = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${signWith({ expiresIn: -10 })}` },
    });
    const invalid = await app.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${signWith({}, {})}`.replace(signWith({}, {}), "garbage.token.value") },
    });

    expect(expired.json().code).toBe("TOKEN_EXPIRED");
    expect(invalid.json().code).toBe("INVALID_TOKEN");
    expect(expired.json().code).not.toBe(invalid.json().code);
  });
});
