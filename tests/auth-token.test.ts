import { describe, it, expect } from "vitest";
import jwt, { type SignOptions } from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { signToken, verifyToken } from "../src/plugins/auth";
import { config } from "../src/config";

/**
 * Dedicated unit tests for the JWT session-token helpers (issue #438).
 *
 * `tests/plugins/auth.test.ts` already covers the HTTP-facing behaviours
 * (error classification, algorithm confusion, claim tampering). These tests
 * target the token utilities themselves: the structure of what `signToken`
 * mints, the claim contract `verifyToken` enforces beyond the SDK's own
 * checks, and the expiry handling that decides between TOKEN_EXPIRED and
 * INVALID_TOKEN.
 */

const makeUser = () => ({
  id: "user_token_test",
  stellarPublicKey: Keypair.random().publicKey(),
});

const signWith = (payload: object, options: SignOptions) =>
  jwt.sign(payload as jwt.JwtPayload, config.JWT_SECRET, {
    algorithm: "HS256",
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    ...options,
  });

describe("signToken", () => {
  it("produces a compact JWS with three segments", () => {
    const token = signToken(makeUser());
    const segments = token.split(".");

    expect(segments).toHaveLength(3);
    for (const segment of segments) {
      // Every segment of an HS256 JWS is non-empty base64url.
      expect(segment.length).toBeGreaterThan(0);
      expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("declares alg HS256 and typ JWT in the header", () => {
    const token = signToken(makeUser());
    const header = JSON.parse(
      Buffer.from(token.split(".")[0]!, "base64url").toString("utf-8")
    );

    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
  });

  it("carries the subject and the stellar public key claims", () => {
    const user = makeUser();
    const payload = jwt.decode(signToken(user)) as jwt.JwtPayload;

    expect(payload.sub).toBe(user.id);
    expect(payload.pk).toBe(user.stellarPublicKey);
  });

  it("carries iat, exp, and the configured issuer and audience", () => {
    const before = Math.floor(Date.now() / 1000);
    const payload = jwt.decode(signToken(makeUser())) as jwt.JwtPayload;
    const after = Math.floor(Date.now() / 1000);

    expect(payload.iat).toBeGreaterThanOrEqual(before);
    expect(payload.iat).toBeLessThanOrEqual(after);
    expect(payload.exp).toBe(payload.iat + config.ACCESS_TOKEN_TTL_SECONDS);
    expect(payload.iss).toBe(config.JWT_ISSUER);
    expect(payload.aud).toBe(config.JWT_AUDIENCE);
  });

  it("honours ACCESS_TOKEN_TTL_SECONDS for the token lifetime", () => {
    expect(config.ACCESS_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(config.jwtExpiresIn).toBe(`${config.ACCESS_TOKEN_TTL_SECONDS}s`);
  });

  it("embeds the whole user identity, so verifyToken round-trips it", () => {
    const user = makeUser();
    expect(verifyToken(signToken(user))).toEqual(user);
  });
});

describe("verifyToken — expiry handling", () => {
  it("accepts a token with plenty of lifetime left", () => {
    const token = signWith(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      { expiresIn: config.ACCESS_TOKEN_TTL_SECONDS }
    );
    expect(verifyToken(token)).toEqual({
      id: "user_1",
      stellarPublicKey: expect.any(String),
    });
  });

  it("rejects an expired token as TOKEN_EXPIRED, not INVALID_TOKEN", () => {
    // The credential was once good — the remedy is re-authentication, which
    // is why the classification (and therefore the client's behaviour) differs.
    const token = signWith({ sub: "user_1", pk: Keypair.random().publicKey() }, {
      expiresIn: -60,
    });

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_EXPIRED" })
    );
  });

  it("rejects a token inside the near-expiry margin as TOKEN_EXPIRED", () => {
    // The margin (default 30s) exists so a token forged or replayed moments
    // before expiry never grants a session even though the SDK would take it.
    const margin = config.TOKEN_EXPIRY_MARGIN_SECONDS ?? 30;
    const token = signWith({ sub: "user_1", pk: Keypair.random().publicKey() }, {
      expiresIn: Math.max(margin - 5, 1),
    });

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "TOKEN_EXPIRED" })
    );
  });

  it("accepts a token whose remaining lifetime clears the margin", () => {
    const margin = config.TOKEN_EXPIRY_MARGIN_SECONDS ?? 30;
    const token = signWith({ sub: "user_1", pk: Keypair.random().publicKey() }, {
      expiresIn: margin + 60,
    });

    expect(verifyToken(token)).toEqual({
      id: "user_1",
      stellarPublicKey: expect.any(String),
    });
  });
});

describe("verifyToken — claim and structure validation", () => {
  it("rejects a token missing the expiry claim", () => {
    const { exp: _exp, ...withoutExp } = jwt.decode(
      signToken(makeUser())
    ) as jwt.JwtPayload;

    const token = jwt.sign(withoutExp, config.JWT_SECRET, {
      algorithm: "HS256",
    });

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("rejects a token missing the subject claim", () => {
    const token = signWith({ pk: Keypair.random().publicKey() }, {});

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("rejects a token missing the public-key claim", () => {
    const token = signWith({ sub: "user_1" }, {});

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("rejects empty-string claims, not just missing ones", () => {
    const token = signWith({ sub: "", pk: Keypair.random().publicKey() }, {});

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("rejects a truncated token (missing signature segment)", () => {
    const token = signToken(makeUser());
    const truncated = token.split(".").slice(0, 2).join(".");

    expect(() => verifyToken(truncated)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("rejects a token that is not a JWT at all", () => {
    for (const garbage of ["", "not-a-token", "a.b.c", "....."]) {
      expect(() => verifyToken(garbage)).toThrow(
        expect.objectContaining({ code: "INVALID_TOKEN" })
      );
    }
  });

  it("rejects a token signed with a non-HS256 algorithm", () => {
    const token = jwt.sign(
      {
        sub: "user_1",
        pk: Keypair.random().publicKey(),
        iss: config.JWT_ISSUER,
        aud: config.JWT_AUDIENCE,
      },
      config.JWT_SECRET,
      { algorithm: "HS512" }
    );

    // The signature itself is valid for this secret, but the pinned algorithm
    // list only admits HS256.
    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("rejects a not-yet-valid token (nbf in the future)", () => {
    const token = signWith(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      { notBefore: 3600 }
    );

    expect(() => verifyToken(token)).toThrow(
      expect.objectContaining({ code: "INVALID_TOKEN" })
    );
  });

  it("never echoes the underlying jsonwebtoken error text", () => {
    // The raw message can reveal which claim mismatched — the app error must
    // carry only the coarse code.
    const token = signWith(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      { issuer: "some-other-issuer" }
    );

    try {
      verifyToken(token);
      expect.unreachable("verifyToken should have thrown");
    } catch (error) {
      expect((error as Error).message).not.toContain("jwt issuer invalid");
      expect((error as Error).message).not.toBe("jwt expired");
    }
  });
});
