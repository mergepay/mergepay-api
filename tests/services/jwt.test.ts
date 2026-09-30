/**
 * Issue #421 — the typed JWT utility wrapper in `src/services/jwt.ts`.
 *
 * The wrapper is the service-layer home for the `signToken`/`verifyToken`
 * pair and for `jwtClaimsSchema`, the contract for what a session payload
 * looks like. These tests drive that module directly (no Fastify instance, no
 * database) so the three properties the issue asks for are pinned at the
 * source:
 *
 *   1. a token minted here round-trips back to the same identity;
 *   2. a token that is expired, malformed, forged, or missing claims is
 *      rejected — with the coarse code a client branches on, never the
 *      underlying `jsonwebtoken` error text;
 *   3. the payload shape is described by a Zod schema that can be reused for
 *      typing and validation elsewhere.
 *
 * It also locks in that the plugin re-exports the same functions, so the
 * existing `src/plugins/auth` import surface keeps working after the move.
 */
import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";

import {
  signToken,
  verifyToken,
  jwtClaimsSchema,
  type AuthUser,
} from "../../src/services/jwt";
import {
  signToken as pluginSignToken,
  verifyToken as pluginVerifyToken,
} from "../../src/plugins/auth";
import { config } from "../../src/config";
import { AppError } from "../../src/errors";

const USER: AuthUser = {
  id: "user_jwt_wrapper",
  stellarPublicKey: Keypair.random().publicKey(),
};

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

describe("jwt wrapper — signing", () => {
  it("mints a compact HS256 token carrying the session claims", () => {
    const token = signToken(USER);
    expect(token.split(".")).toHaveLength(3);

    const header = jwt.decode(token, { complete: true })!.header;
    expect(header.alg).toBe("HS256");

    const payload = jwt.decode(token) as jwt.JwtPayload;
    expect(payload.sub).toBe(USER.id);
    expect(payload.pk).toBe(USER.stellarPublicKey);
    expect(payload.iss).toBe(config.JWT_ISSUER);
    expect(payload.aud).toBe(config.JWT_AUDIENCE);
    expect(typeof payload.exp).toBe("number");
  });

  it("applies the configured lifetime", () => {
    const payload = jwt.decode(signToken(USER)) as jwt.JwtPayload;
    const lifetime = (payload.exp as number) - (payload.iat as number);
    expect(lifetime).toBe(config.ACCESS_TOKEN_TTL_SECONDS);
  });

  it("sets the jti from the supplied jwtid", () => {
    const payload = jwt.decode(signToken(USER, { jwtid: "tx-hash-1" })) as jwt.JwtPayload;
    expect(payload.jti).toBe("tx-hash-1");
  });
});

describe("jwt wrapper — round-trip", () => {
  it("returns the original identity for a freshly signed token", () => {
    expect(verifyToken(signToken(USER))).toEqual(USER);
  });

  it("re-exports the same functions from the auth plugin", () => {
    expect(pluginSignToken).toBe(signToken);
    expect(pluginVerifyToken).toBe(verifyToken);
    expect(pluginVerifyToken(pluginSignToken(USER))).toEqual(USER);
  });
});

describe("jwt wrapper — verification", () => {
  it("classifies an expired token as TOKEN_EXPIRED", () => {
    const err = expectAppError(
      () => verifyToken(signWith({ expiresIn: -10 })),
      "TOKEN_EXPIRED"
    );
    expect(err.message).toBe("Token expired");
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign(
      { sub: USER.id, pk: USER.stellarPublicKey },
      "a-different-secret-key-16chars",
      { algorithm: "HS256", expiresIn: "1h", issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }
    );
    expectAppError(() => verifyToken(forged), "INVALID_TOKEN");
  });

  it("rejects a malformed token", () => {
    expectAppError(() => verifyToken("not-a-jwt"), "INVALID_TOKEN");
  });

  it("rejects a payload missing its pk claim", () => {
    expectAppError(() => verifyToken(signWith({ expiresIn: "1h" }, { sub: USER.id })), "INVALID_TOKEN");
  });

  it("rejects a payload with an empty sub claim", () => {
    expectAppError(
      () => verifyToken(signWith({ expiresIn: "1h" }, { sub: "", pk: USER.stellarPublicKey })),
      "INVALID_TOKEN"
    );
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

describe("jwtClaimsSchema", () => {
  it("accepts the claims this server mints", () => {
    const parsed = jwtClaimsSchema.safeParse({
      sub: USER.id,
      pk: USER.stellarPublicKey,
      iss: config.JWT_ISSUER,
      aud: config.JWT_AUDIENCE,
      iat: 1,
      exp: 2,
      jti: "abc",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sub).toBe(USER.id);
      expect(parsed.data.pk).toBe(USER.stellarPublicKey);
    }
  });

  it("requires sub and pk to be non-empty strings", () => {
    expect(jwtClaimsSchema.safeParse({ pk: USER.stellarPublicKey }).success).toBe(false);
    expect(jwtClaimsSchema.safeParse({ sub: USER.id }).success).toBe(false);
    expect(jwtClaimsSchema.safeParse({ sub: "", pk: USER.stellarPublicKey }).success).toBe(false);
    expect(jwtClaimsSchema.safeParse({ sub: 42, pk: USER.stellarPublicKey }).success).toBe(false);
  });

  it("ignores unknown claims so future additions never invalidate old sessions", () => {
    expect(
      jwtClaimsSchema.safeParse({ sub: USER.id, pk: USER.stellarPublicKey, future: "x" }).success
    ).toBe(true);
  });
});
