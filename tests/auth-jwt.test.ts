/**
 * JWT helper unit tests — creation, expiration checking, and signature
 * verification for the SEP-10 session token (src/plugins/auth.ts).
 *
 * `signToken`/`verifyToken` are the only place a session credential is minted
 * or accepted: every authenticated route funnels through them, and the
 * `/auth/verify` step of the SEP-10 flow issues their output. A regression
 * there is an authentication bypass or a lockout, so the helpers are pinned
 * directly rather than only through the Fastify middleware path.
 *
 * Three properties are asserted for each helper:
 *
 *   - creation → HS256 compact JWT carrying the configured claims
 *   - expiry   → expired, near-expired, and not-yet-valid tokens are refused,
 *                with TOKEN_EXPIRED (re-authenticate) kept distinct from
 *                INVALID_TOKEN (stop sending this credential)
 *   - signature → forged, tampered, wrong-algorithm, and wrong-issuer/audience
 *                tokens are refused, and no rejection leaks the underlying
 *                jsonwebtoken error text
 */
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import type { FastifyRequest } from "fastify";

import { signToken, verifyToken, requireUser, AuthUser } from "../src/plugins/auth";
import { config } from "../src/config";
import { AppError } from "../src/errors";

const USER: AuthUser = {
  id: "user_jwt_1",
  stellarPublicKey: Keypair.random().publicKey(),
};

const MARGIN = config.TOKEN_EXPIRY_MARGIN_SECONDS ?? 30;

/** Sign with the real secret but arbitrary claims/options. */
function signWith(
  options: jwt.SignOptions,
  claims: Record<string, unknown> = { sub: USER.id, pk: USER.stellarPublicKey }
) {
  return jwt.sign(claims, config.JWT_SECRET, {
    algorithm: "HS256",
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE,
    ...options,
  });
}

/** Assert `fn` throws an AppError with the given machine code and a 401. */
function expectAppError(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const err = error as AppError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(401);
    return err;
  }
  throw new Error(`expected an AppError with code ${code}, but nothing was thrown`);
}

describe("signToken — token creation", () => {
  it("produces a compact three-part JWT", () => {
    const token = signToken(USER);
    expect(token.split(".")).toHaveLength(3);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("declares HS256 in the header, never alg none", () => {
    const header = jwt.decode(signToken(USER), { complete: true })!.header;
    expect(header.alg).toBe("HS256");
    expect(header.alg).not.toBe("none");
    expect(header.typ).toBe("JWT");
  });

  it("carries the session claims for the signed user", () => {
    const decoded = jwt.decode(signToken(USER)) as jwt.JwtPayload;
    expect(decoded.sub).toBe(USER.id);
    expect(decoded.pk).toBe(USER.stellarPublicKey);
  });

  it("embeds the configured issuer, audience, and issuance time", () => {
    const before = Math.floor(Date.now() / 1000);
    const decoded = jwt.decode(signToken(USER)) as jwt.JwtPayload;
    const after = Math.floor(Date.now() / 1000);

    expect(decoded.iss).toBe(config.JWT_ISSUER);
    expect(decoded.aud).toBe(config.JWT_AUDIENCE);
    expect(decoded.iat).toBeGreaterThanOrEqual(before);
    expect(decoded.iat).toBeLessThanOrEqual(after);
  });

  it("expires after the configured access-token TTL", () => {
    const decoded = jwt.decode(signToken(USER)) as jwt.JwtPayload;
    expect(decoded.exp).toBe(decoded.iat! + config.ACCESS_TOKEN_TTL_SECONDS);
  });

  it("signs with the configured secret, so verification with it succeeds", () => {
    const token = signToken(USER);
    const verified = jwt.verify(token, config.JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }) as jwt.JwtPayload;

    expect(verified.sub).toBe(USER.id);
    expect(verified.pk).toBe(USER.stellarPublicKey);
  });

  it("mints a different token per account", () => {
    const other: AuthUser = {
      id: "user_jwt_2",
      stellarPublicKey: Keypair.random().publicKey(),
    };
    expect(signToken(USER)).not.toBe(signToken(other));
  });
});

describe("verifyToken — valid verification", () => {
  it("round-trips a freshly signed token", () => {
    expect(verifyToken(signToken(USER))).toEqual({
      id: USER.id,
      stellarPublicKey: USER.stellarPublicKey,
    });
  });

  it("accepts a token with a healthy remaining lifetime", () => {
    const token = signWith({ expiresIn: MARGIN + 600 });
    expect(verifyToken(token).id).toBe(USER.id);
  });
});

describe("verifyToken — signature verification", () => {
  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign(
      { sub: USER.id, pk: USER.stellarPublicKey },
      "wrong-secret-entirely",
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: 900,
      }
    );
    expectAppError(() => verifyToken(forged), "INVALID_TOKEN");
  });

  it("rejects a token whose payload was tampered with after signing", () => {
    const [headerB64, , sigB64] = signToken(USER).split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: USER.id,
        pk: Keypair.random().publicKey(),
        iss: config.JWT_ISSUER,
        aud: config.JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");

    expectAppError(
      () => verifyToken(`${headerB64}.${tamperedPayload}.${sigB64}`),
      "INVALID_TOKEN"
    );
  });

  it("rejects a token whose signature was replaced", () => {
    const [headerB64, payloadB64] = signToken(USER).split(".");
    expectAppError(
      () => verifyToken(`${headerB64}.${payloadB64}.AAAAAAAAAAAAAAAAAAAAA`),
      "INVALID_TOKEN"
    );
  });

  it("rejects an unsigned alg-none token", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url"
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: USER.id,
        pk: USER.stellarPublicKey,
        iss: config.JWT_ISSUER,
        aud: config.JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");

    expectAppError(() => verifyToken(`${header}.${payload}.`), "INVALID_TOKEN");
  });

  it("rejects an HS512 token even when signed with the real secret", () => {
    const token = jwt.sign(
      { sub: USER.id, pk: USER.stellarPublicKey },
      config.JWT_SECRET,
      {
        algorithm: "HS512",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: 900,
      }
    );
    expectAppError(() => verifyToken(token), "INVALID_TOKEN");
  });

  it.each([
    ["an empty string", ""],
    ["a non-JWT value", "not-a-jwt"],
    ["a truncated token", "a.b.c"],
    ["a token with an empty signature", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0."],
  ])("rejects %s as malformed", (_label, token) => {
    expectAppError(() => verifyToken(token), "INVALID_TOKEN");
  });
});

describe("verifyToken — expiration checking", () => {
  it("classifies an expired token as TOKEN_EXPIRED", () => {
    const err = expectAppError(
      () => verifyToken(signWith({ expiresIn: -10 })),
      "TOKEN_EXPIRED"
    );
    expect(err.message).toBe("Token expired");
  });

  it("classifies a token inside the expiry margin as TOKEN_EXPIRED", () => {
    const err = expectAppError(
      () => verifyToken(signWith({ expiresIn: Math.max(1, MARGIN - 5) })),
      "TOKEN_EXPIRED"
    );
    expect(err.message).toBe("Token is near expiry");
  });

  it("accepts a token whose remaining lifetime is outside the margin", () => {
    const token = signWith({ expiresIn: MARGIN + 60 });
    expect(verifyToken(token).id).toBe(USER.id);
  });

  it("classifies a token missing its expiry claim as INVALID_TOKEN", () => {
    const token = jwt.sign({ sub: USER.id, pk: USER.stellarPublicKey }, config.JWT_SECRET, {
      algorithm: "HS256",
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    expectAppError(() => verifyToken(token), "INVALID_TOKEN");
  });

  it("classifies a not-yet-valid token as INVALID_TOKEN", () => {
    expectAppError(
      () => verifyToken(signWith({ notBefore: "10m", expiresIn: "30m" })),
      "INVALID_TOKEN"
    );
  });

  it("reports TOKEN_EXPIRED with a re-authentication hint", () => {
    const err = expectAppError(
      () => verifyToken(signWith({ expiresIn: -10 })),
      "TOKEN_EXPIRED"
    );
    const hint = (err.details as { hint?: string })?.hint;
    expect(hint).toMatch(/SEP-10/);
    expect(hint).toMatch(/\/auth\/refresh/);
  });

  it("never echoes the underlying jsonwebtoken error text", () => {
    expect(() => verifyToken(signWith({ expiresIn: -10 }))).toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/jwt expired/i) })
    );
    expect(() => verifyToken("not-a-jwt")).toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/jwt malformed/i) })
    );
  });
});

describe("verifyToken — claim validation", () => {
  it("rejects a token with the wrong issuer", () => {
    expectAppError(
      () => verifyToken(signWith({ issuer: "some-other-issuer" })),
      "INVALID_TOKEN"
    );
  });

  it("rejects a token with the wrong audience", () => {
    expectAppError(
      () => verifyToken(signWith({ audience: "some-other-audience" })),
      "INVALID_TOKEN"
    );
  });

  it("rejects a token missing the stellar public key claim", () => {
    expectAppError(
      () => verifyToken(signWith({}, { sub: USER.id })),
      "INVALID_TOKEN"
    );
  });

  it("rejects a token with empty session claims", () => {
    expectAppError(
      () => verifyToken(signWith({}, { sub: "", pk: "" })),
      "INVALID_TOKEN"
    );
  });

  it("rejects a token with a non-string subject", () => {
    expectAppError(
      () => verifyToken(signWith({}, { sub: 42, pk: USER.stellarPublicKey })),
      "INVALID_TOKEN"
    );
  });

  it("does not carry a hint on INVALID_TOKEN — there is nothing to refresh", () => {
    const err = expectAppError(
      () => verifyToken(signWith({ audience: "some-other-audience" })),
      "INVALID_TOKEN"
    );
    expect(err.details).toBeUndefined();
  });
});

describe("requireUser", () => {
  it("returns the user attached to the request", () => {
    const req = { user: USER } as FastifyRequest;
    expect(requireUser(req)).toEqual(USER);
  });

  it("throws UNAUTHORIZED when no user was authenticated", () => {
    const err = expectAppError(() => requireUser({} as FastifyRequest), "UNAUTHORIZED");
    expect(err.message).toBe("Authentication required");
  });
});
