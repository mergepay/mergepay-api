import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { signToken, verifyToken } from "../../src/plugins/auth";
import { config } from "../../src/config";

describe("JWT issuance / verification", () => {
  it("round-trips a valid token", () => {
    const user = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
    const token = signToken(user);
    expect(verifyToken(token)).toEqual(user);
  });

  it("embeds the configured issuer and audience", () => {
    const user = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
    const token = signToken(user);
    const decoded = jwt.decode(token) as jwt.JwtPayload;
    expect(decoded.iss).toBe(config.JWT_ISSUER);
    expect(decoded.aud).toBe(config.JWT_AUDIENCE);
  });

  it("rejects a token signed with a different secret", () => {
    const forged = jwt.sign(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      "wrong-secret",
      { algorithm: "HS256", issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE }
    );
    expect(() => verifyToken(forged)).toThrow();
  });

  it("rejects a token with the wrong issuer", () => {
    const token = jwt.sign(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      config.JWT_SECRET,
      { algorithm: "HS256", issuer: "some-other-issuer", audience: config.JWT_AUDIENCE }
    );
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects a token with the wrong audience", () => {
    const token = jwt.sign(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      config.JWT_SECRET,
      { algorithm: "HS256", issuer: config.JWT_ISSUER, audience: "some-other-audience" }
    );
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects an expired token", () => {
    const token = jwt.sign(
      { sub: "user_1", pk: Keypair.random().publicKey() },
      config.JWT_SECRET,
      {
        algorithm: "HS256",
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
        expiresIn: -10,
      }
    );
    expect(() => verifyToken(token)).toThrow();
  });

  it("rejects a token signed with a different algorithm", () => {
    // none-alg / mismatched-alg tokens must never be accepted even if the
    // payload and claims are otherwise well formed.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString(
      "base64url"
    );
    const payload = Buffer.from(
      JSON.stringify({
        sub: "user_1",
        pk: Keypair.random().publicKey(),
        iss: config.JWT_ISSUER,
        aud: config.JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");
    const forged = `${header}.${payload}.`;

    expect(() => verifyToken(forged)).toThrow();
  });

  it("rejects a token missing the account claim", () => {
    const token = jwt.sign({ sub: "user_1" }, config.JWT_SECRET, {
      algorithm: "HS256",
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });
    expect(() => verifyToken(token)).toThrow();
  });

  it("cannot be coerced into authenticating as a different account by tampering with claims", () => {
    const legit = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
    const token = signToken(legit);
    const [headerB64, , sigB64] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        sub: "user_1",
        pk: Keypair.random().publicKey(), // swapped account
        iss: config.JWT_ISSUER,
        aud: config.JWT_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      })
    ).toString("base64url");
    const tampered = `${headerB64}.${tamperedPayload}.${sigB64}`;

    expect(() => verifyToken(tampered)).toThrow();
  });
});
