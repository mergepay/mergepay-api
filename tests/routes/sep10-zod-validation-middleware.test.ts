import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const buildChallenge = vi.fn(async (account: string) => ({
    transaction: "AAAAAgAAAAB...mock_xdr...",
    networkPassphrase: "Test SDF Network ; September 2015",
  }));

  const authenticateChallenge = vi.fn(async (xdr: string) => ({
    token: "jwt_token_sample",
  }));

  return { buildChallenge, authenticateChallenge };
});

vi.mock("../../src/services/sep10", () => ({
  buildChallenge: h.buildChallenge,
  authenticateChallenge: h.authenticateChallenge,
}));

import sep10Routes, {
  validateSep10ChallengeHook,
  validateSep10VerifyHook,
} from "../../src/routes/sep10";
import {
  sep10ChallengeQuerySchema,
  sep10ChallengeRequestSchema,
  sep10VerifyRequestSchema,
} from "../../src/validations/sep10";
import errorHandlerPlugin from "../../src/plugins/error-handler";
import { config } from "../../src/config";

const validKeypair = Keypair.random();
const VALID_STELLAR_PUBKEY = validKeypair.publicKey();
const INVALID_STELLAR_PUBKEY = "INVALID_NOT_A_REAL_STELLAR_PUBKEY";
const VALID_CANONICAL_XDR = Buffer.alloc(4, 0).toString("base64"); // "AAAAAA=="

describe("SEP-10 Zod Request Validation Middleware (#875)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify();
    await app.register(errorHandlerPlugin);
    await app.register(sep10Routes);
    await app.ready();
  });

  describe("Zod validation schemas", () => {
    it("validates sep10ChallengeQuerySchema with valid account", () => {
      const parsed = sep10ChallengeQuerySchema.parse({
        account: VALID_STELLAR_PUBKEY,
      });
      expect(parsed.account).toBe(VALID_STELLAR_PUBKEY);
    });

    it("rejects sep10ChallengeQuerySchema when account is malformed", () => {
      expect(() =>
        sep10ChallengeQuerySchema.parse({ account: INVALID_STELLAR_PUBKEY })
      ).toThrow();
    });

    it("rejects sep10ChallengeRequestSchema when account is missing", () => {
      expect(() => sep10ChallengeRequestSchema.parse({})).toThrow();
    });

    it("rejects sep10VerifyRequestSchema when transaction is invalid base64", () => {
      expect(() =>
        sep10VerifyRequestSchema.parse({ transaction: "not@valid!base64==" })
      ).toThrow();
    });
  });

  describe("GET /sep10/challenge route validation middleware", () => {
    it("returns 200 with challenge transaction for valid public key query param", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/sep10/challenge?account=${VALID_STELLAR_PUBKEY}`,
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.transaction).toBeDefined();
      expect(body.networkPassphrase).toBeDefined();
      expect(h.buildChallenge).toHaveBeenCalledWith(VALID_STELLAR_PUBKEY);
    });

    it("returns 400 VALIDATION_ERROR when query account parameter is missing", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/sep10/challenge",
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("account");
      expect(h.buildChallenge).not.toHaveBeenCalled();
    });

    it("returns 400 VALIDATION_ERROR when query account parameter is invalid format", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/sep10/challenge?account=${INVALID_STELLAR_PUBKEY}`,
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(h.buildChallenge).not.toHaveBeenCalled();
    });

    it("rejects a home_domain claim for a different domain", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/sep10/challenge?account=${VALID_STELLAR_PUBKEY}&home_domain=evil.example.com`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("HOME_DOMAIN_MISMATCH");
      expect(h.buildChallenge).not.toHaveBeenCalled();
    });

    it("rejects a client_domain claim", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/sep10/challenge?account=${VALID_STELLAR_PUBKEY}&client_domain=wallet.example.com`,
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("CLIENT_DOMAIN_UNSUPPORTED");
      expect(h.buildChallenge).not.toHaveBeenCalled();
    });
  });

  describe("POST /sep10/challenge route validation middleware", () => {
    it("returns 200 with challenge transaction for valid public key in body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/challenge",
        payload: { account: VALID_STELLAR_PUBKEY },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().transaction).toBeDefined();
      expect(h.buildChallenge).toHaveBeenCalledWith(VALID_STELLAR_PUBKEY);
    });

    it("returns 400 VALIDATION_ERROR when POST payload is missing account", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/challenge",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(h.buildChallenge).not.toHaveBeenCalled();
    });

    it("returns 400 VALIDATION_ERROR when POST challenge includes unexpected query params", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/sep10/challenge?unexpected=1`,
        payload: { account: VALID_STELLAR_PUBKEY },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("POST /sep10/verify route validation middleware", () => {
    it("returns 400 VALIDATION_ERROR when transaction is missing from payload", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/verify",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.message).toContain("transaction");
      expect(h.authenticateChallenge).not.toHaveBeenCalled();
    });

    it("returns 400 VALIDATION_ERROR when transaction XDR is not canonical base64", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/verify",
        payload: { transaction: "invalid--base64$$" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
      expect(h.authenticateChallenge).not.toHaveBeenCalled();
    });

    it("returns 200 and calls authenticateChallenge when valid canonical base64 XDR is passed", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/verify",
        payload: { transaction: VALID_CANONICAL_XDR },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().token).toBe("jwt_token_sample");
      expect(h.authenticateChallenge).toHaveBeenCalledWith(VALID_CANONICAL_XDR);
    });

    it("rejects a verify payload with a home_domain claim for a different domain", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/verify",
        payload: { transaction: VALID_CANONICAL_XDR, home_domain: "evil.example.com" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("HOME_DOMAIN_MISMATCH");
      expect(h.authenticateChallenge).not.toHaveBeenCalled();
    });

    it("rejects a verify payload with a client_domain claim", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/verify",
        payload: { transaction: VALID_CANONICAL_XDR, client_domain: "wallet.example.com" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("CLIENT_DOMAIN_UNSUPPORTED");
      expect(h.authenticateChallenge).not.toHaveBeenCalled();
    });

    it("accepts a verify payload whose home_domain matches this server", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sep10/verify",
        payload: { transaction: VALID_CANONICAL_XDR, home_domain: config.SEP10_HOME_DOMAIN },
      });

      expect(res.statusCode).toBe(200);
      expect(h.authenticateChallenge).toHaveBeenCalledWith(VALID_CANONICAL_XDR);
    });
  });
});
