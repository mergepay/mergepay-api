import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from "vitest";
import fastify, { FastifyInstance } from "fastify";
import { Keypair, Networks, Transaction, WebAuth, xdr } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const prisma: any = {
    user: { upsert: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
    refreshToken: { create: vi.fn(async () => ({})) },
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma, loadAccount: vi.fn() };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
  return { ...actual, stellar: { ...actual.stellar, loadAccount: h.loadAccount } };
});

import { config } from "../../src/config";
import errorHandlerPlugin from "../../src/plugins/error-handler";
import authPlugin, { requireUser } from "../../src/plugins/auth";
import {
  authenticateChallenge,
  buildChallenge,
  classifySep10Error,
  serverKeypair,
  verifyChallenge,
  CHALLENGE_VALIDITY_SECONDS,
} from "../../src/services/auth";
import { AppError, ErrorCode, Errors } from "../../src/errors";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../../src/lib/time-bounds";

const T0 = new Date("2026-10-24T12:00:00.000Z");
const UNFUNDED = {
  exists: false,
  sequence: "0",
  balances: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
};

const OTHER_NETWORK =
  config.networkPassphrase === Networks.TESTNET ? Networks.PUBLIC : Networks.TESTNET;

describe("Auth Service & SEP-10 Verification Error Handling (#885)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = fastify();
    await app.register(errorHandlerPlugin);
    await app.register(authPlugin);

    app.get("/test-protected", { preHandler: [app.authenticate] }, async (req) => {
      const user = requireUser(req);
      return { ok: true, user, sep10Account: req.sep10Account };
    });

    app.post("/test-sep10-hook", { preHandler: [app.authenticateSep10] }, async (req) => {
      return { ok: true, sep10Account: req.sep10Account, user: req.user };
    });

    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
    h.loadAccount.mockReset().mockResolvedValue(UNFUNDED);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function challenge(
    client: Keypair,
    opts: { homeDomain?: string; passphrase?: string; server?: Keypair; webAuthDomain?: string } = {}
  ): string {
    return WebAuth.buildChallengeTx(
      opts.server ?? serverKeypair(),
      client.publicKey(),
      opts.homeDomain ?? config.SEP10_HOME_DOMAIN,
      CHALLENGE_VALIDITY_SECONDS,
      opts.passphrase ?? config.networkPassphrase,
      opts.webAuthDomain ?? config.WEB_AUTH_DOMAIN
    );
  }

  function sign(
    challengeXdr: string,
    signers: Keypair[],
    passphrase: string = config.networkPassphrase
  ): string {
    const tx = new Transaction(challengeXdr, passphrase);
    for (const signer of signers) tx.sign(signer);
    return tx.toXDR();
  }

  describe("classifySep10Error", () => {
    it("preserves an existing AppError instance untouched", () => {
      const custom = new AppError(403, ErrorCode.FORBIDDEN, "Access denied");
      expect(classifySep10Error(custom)).toBe(custom);
    });

    it("classifies expired error strings into CHALLENGE_EXPIRED", () => {
      const err = new Error("The transaction has expired past max_time");
      const classified = classifySep10Error(err);
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.CHALLENGE_EXPIRED);
      expect(classified.details).toEqual({ challengeValiditySeconds: CHALLENGE_VALIDITY_SECONDS });
    });

    it("classifies not-yet-valid errors into CHALLENGE_NOT_YET_VALID", () => {
      const err = new Error("Challenge min_time has not yet valid");
      const classified = classifySep10Error(err);
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.CHALLENGE_NOT_YET_VALID);
    });

    it("classifies window length violations into CHALLENGE_WINDOW_TOO_LONG", () => {
      const err = new Error("Challenge window length exceeds allowed limit");
      const classified = classifySep10Error(err);
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.CHALLENGE_WINDOW_TOO_LONG);
    });

    it("classifies home domain mismatches into HOME_DOMAIN_MISMATCH", () => {
      const err = new Error("Invalid homeDomain: domain does not match expected");
      const classified = classifySep10Error(err);
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.HOME_DOMAIN_MISMATCH);
    });

    it("classifies network passphrase errors into NETWORK_MISMATCH", () => {
      const err = new Error("Network passphrase mismatch during validation");
      const classified = classifySep10Error(err);
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.NETWORK_MISMATCH);
    });

    it("classifies signature and signer failures into INVALID_SIGNATURE", () => {
      const err = new Error("None of the given signers match the transaction signatures");
      const classified = classifySep10Error(err);
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.INVALID_SIGNATURE);
    });

    it.each([
      "Network fetch failed while parsing the transaction",
      "Domain model failed to initialize",
      "verify helper crashed while formatting output",
    ])("does not treat unrelated internal errors as challenge failures: %s", (message) => {
      const classified = classifySep10Error(new Error(message));
      expect(classified.status).toBe(401);
      expect(classified.code).toBe(ErrorCode.INVALID_CHALLENGE);
      expect(classified.message).not.toContain(message);
    });
  });

  describe("authenticateChallenge & verifyChallenge service methods", () => {
    it("successfully validates a legitimate signed challenge", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client), [client]);

      const verified = await authenticateChallenge(signed);
      expect(verified.account).toBe(client.publicKey());
      expect(typeof verified.challengeHash).toBe("string");

      const client2 = Keypair.random();
      const signed2 = sign(challenge(client2), [client2]);
      const pubKey = await verifyChallenge(signed2);
      expect(pubKey).toBe(client2.publicKey());
    });

    it("rejects expired challenges with CHALLENGE_EXPIRED", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client), [client]);

      vi.setSystemTime(
        new Date(T0.getTime() + (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 2) * 1000)
      );

      await expect(authenticateChallenge(signed)).rejects.toMatchObject({
        status: 401,
        code: ErrorCode.CHALLENGE_EXPIRED,
      });
    });

    it("rejects missing client signature with INVALID_SIGNATURE", async () => {
      const client = Keypair.random();
      const unsigned = challenge(client);

      await expect(authenticateChallenge(unsigned)).rejects.toMatchObject({
        status: 401,
        code: ErrorCode.INVALID_SIGNATURE,
      });
    });

    it("rejects wrong home domain with HOME_DOMAIN_MISMATCH", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client, { homeDomain: "wrong-anchor.org" }), [client]);

      await expect(authenticateChallenge(signed)).rejects.toMatchObject({
        status: 401,
        code: ErrorCode.HOME_DOMAIN_MISMATCH,
      });
    });

    it("rejects wrong network with NETWORK_MISMATCH", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client, { passphrase: OTHER_NETWORK }), [client], OTHER_NETWORK);

      await expect(authenticateChallenge(signed)).rejects.toMatchObject({
        status: 401,
        code: ErrorCode.NETWORK_MISMATCH,
      });
    });
  });

  describe("Fastify authenticate hook with SEP10 header", () => {
    it("authenticates when valid SEP-10 challenge is passed in Authorization header", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client), [client]);

      const res = await app.inject({
        method: "GET",
        url: "/test-protected",
        headers: { authorization: `SEP10 ${signed}` },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.ok).toBe(true);
      expect(json.sep10Account).toBe(client.publicKey());
      expect(json.user.stellarPublicKey).toBe(client.publicKey());
    });

    it("returns explicit 401 JSON error payload when SEP-10 challenge has expired", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client), [client]);

      vi.setSystemTime(
        new Date(T0.getTime() + (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 5) * 1000)
      );

      const res = await app.inject({
        method: "GET",
        url: "/test-protected",
        headers: { authorization: `SEP10 ${signed}` },
      });

      expect(res.statusCode).toBe(401);
      const json = res.json();
      expect(json.error.code).toBe(ErrorCode.CHALLENGE_EXPIRED);
      expect(json.error.message).toContain("expired");
      expect(res.body).not.toContain(serverKeypair().secret());
    });
  });

  describe("Fastify authenticateSep10 hook", () => {
    it("authenticates via X-SEP10-Challenge header", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client), [client]);

      const res = await app.inject({
        method: "POST",
        url: "/test-sep10-hook",
        headers: { "x-sep10-challenge": signed },
      });

      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json.ok).toBe(true);
      expect(json.sep10Account).toBe(client.publicKey());
    });

    it("authenticates via request body transaction field", async () => {
      const client = Keypair.random();
      const signed = sign(challenge(client), [client]);

      const res = await app.inject({
        method: "POST",
        url: "/test-sep10-hook",
        payload: { transaction: signed },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().sep10Account).toBe(client.publicKey());
    });

    it("returns 400 when challenge transaction is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test-sep10-hook",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("MISSING_CHALLENGE");
    });

    it("returns 401 INVALID_SIGNATURE for untrusted signature", async () => {
      const client = Keypair.random();
      const res = await app.inject({
        method: "POST",
        url: "/test-sep10-hook",
        payload: { transaction: challenge(client) }, // unsigned
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe(ErrorCode.INVALID_SIGNATURE);
    });

    it("never leaks secret keys or stack frames in error responses", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/test-sep10-hook",
        payload: { transaction: "not-a-valid-xdr" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("stack");
      expect(res.body).not.toContain(serverKeypair().secret());
      expect(res.body).not.toContain(serverKeypair().publicKey());
    });
  });
});
