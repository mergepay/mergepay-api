import { describe, it, expect } from "vitest";
import jwt from "jsonwebtoken";
import { Keypair } from "@stellar/stellar-sdk";
import { verifyToken, signToken } from "../../src/services/jwt";
import { config } from "../../src/config";
import { AppError } from "../../src/errors";

describe("JWT verification scope and expiration enhancements", () => {
  const user = { id: "user_scope_1", stellarPublicKey: Keypair.random().publicKey() };

  it("successfully verifies token with valid claims and optional scopes", () => {
    const token = jwt.sign(
      { sub: user.id, pk: user.stellarPublicKey, scope: "read write" },
      config.JWT_SECRET,
      { algorithm: "HS256", issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: "1h" }
    );
    const result = verifyToken(token);
    expect(result.id).toBe(user.id);
    expect(result.stellarPublicKey).toBe(user.stellarPublicKey);
  });

  it("handles array scopes correctly", () => {
    const token = jwt.sign(
      { sub: user.id, pk: user.stellarPublicKey, scope: ["read", "write"] },
      config.JWT_SECRET,
      { algorithm: "HS256", issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: "1h" }
    );
    const result = verifyToken(token);
    expect(result.id).toBe(user.id);
  });

  it("rejects expired tokens explicitly", () => {
    const token = jwt.sign(
      { sub: user.id, pk: user.stellarPublicKey },
      config.JWT_SECRET,
      { algorithm: "HS256", issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE, expiresIn: -10 }
    );
    expect(() => verifyToken(token)).toThrow(AppError);
  });
});
