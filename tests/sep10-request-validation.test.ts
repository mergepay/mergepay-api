/**
 * Issue #503 — strict Zod request validation on the SEP-10 endpoints.
 *
 * Every malformed `/auth/challenge` and `/auth/verify` request must be
 * rejected with 400 VALIDATION_ERROR *before* business logic runs: no
 * challenge is built, no XDR is decoded or verified, no user is upserted,
 * and no audit row is written. Valid requests must still succeed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { Account, Keypair, MuxedAccount, Transaction } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const consumed = new Set<string>();
  const prisma: any = {
    user: { upsert: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
    refreshToken: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
      const text = sql.strings.join("?");
      if (text.includes("INSERT INTO")) {
        const [fingerprint] = sql.values as [string];
        if (consumed.has(fingerprint)) return 0;
        consumed.add(fingerprint);
        return 1;
      }
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma, consumed };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

// Spy on the business-logic entry points while keeping their real behaviour,
// so each test can prove whether validation stopped the request first.
vi.mock("../src/services/sep10", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/sep10")>();
  return {
    ...actual,
    buildChallenge: vi.fn(actual.buildChallenge),
    authenticateChallenge: vi.fn(actual.authenticateChallenge),
  };
});

vi.mock("../src/services/refresh-token", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/refresh-token")>();
  return {
    ...actual,
    issueRefreshToken: vi.fn(async () => ({
      token: "refresh-token",
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    })),
  };
});

import { buildApp } from "../src/app";
import { authenticateChallenge, buildChallenge } from "../src/services/sep10";
import { config } from "../src/config";

const realSep10 = await vi.importActual<typeof import("../src/services/sep10")>(
  "../src/services/sep10"
);

let app: Awaited<ReturnType<typeof buildApp>>;

/**
 * The domain checks compare against `config.SEP10_HOME_DOMAIN`, which this
 * environment derives from `API_PUBLIC_URL` as `localhost:4000`. A few cases
 * below pin it to a real domain so the comparison itself is what is under test,
 * and every test hands the environment's value back.
 */
const REAL_HOME_DOMAIN = config.SEP10_HOME_DOMAIN;
const IS_TEST = config.isTest;

beforeEach(async () => {
  vi.clearAllMocks();
  h.consumed.clear();
  h.prisma.auditLog.create.mockImplementation(async () => ({}));
  if (!app) app = await buildApp();
});

afterEach(() => {
  config.SEP10_HOME_DOMAIN = REAL_HOME_DOMAIN;
  config.isTest = IS_TEST;
});

// The auth routes are rate limited per client IP. Each request gets its own
// address so this suite exercises validation, not the limiter.
let ipCounter = 0;
function inject(opts: Parameters<typeof app.inject>[0] & object) {
  ipCounter += 1;
  return app.inject({
    ...(opts as object),
    remoteAddress: `10.50.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`,
  } as Parameters<typeof app.inject>[0]);
}

function signedChallenge(client: Keypair): string {
  const { transaction } = realSep10.buildChallenge(client.publicKey());
  const tx = new Transaction(transaction, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

function expectValidationError(
  res: { statusCode: number; json: () => any },
  field?: string
): void {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.code ?? body.error?.code).toBe("VALIDATION_ERROR");
  if (field) {
    const details: Array<{ field: string }> = body.error?.details ?? body.details ?? [];
    expect(details.map((d) => d.field)).toContain(field);
  }
}

describe("POST /auth/challenge validation", () => {
  it("returns a challenge for a valid account", async () => {
    const client = Keypair.random();
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: client.publicKey() },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transaction).toBeTruthy();
    expect(buildChallenge).toHaveBeenCalledWith(client.publicKey());
  });

  it.each([
    ["missing account", {}],
    ["null account", { account: null }],
    ["numeric account", { account: 42 }],
    ["empty account", { account: "" }],
    ["malformed account", { account: "not-a-key" }],
    ["secret seed", { account: Keypair.random().secret() }],
    ["oversized account", { account: "G".repeat(5_000) }],
  ])("rejects %s with 400 before building a challenge", async (_label, payload) => {
    const res = await inject({ method: "POST", url: "/auth/challenge", payload });
    expectValidationError(res, "account");
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: Keypair.random().publicKey(), role: "admin" },
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects a muxed (M...) account (not supported)", async () => {
    const base = Keypair.random().publicKey();
    const muxed = new MuxedAccount(new Account(base, "0"), "7").accountId();
    const res = await inject({ method: "POST", url: "/auth/challenge", payload: { account: muxed } });

    expectValidationError(res, "account");
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects a SEP-10 memo (not supported)", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: Keypair.random().publicKey(), memo: "12345" },
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects an array body", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      payload: [Keypair.random().publicKey()],
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects a request with no body", async () => {
    const res = await inject({ method: "POST", url: "/auth/challenge" });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: '{"account": ',
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });

  it("rejects the account passed as a query parameter (SEP-10 GET habit)", async () => {
    const account = Keypair.random().publicKey();
    const res = await inject({
      method: "POST",
      url: `/auth/challenge?account=${account}`,
      payload: { account },
    });
    expectValidationError(res);
    expect(buildChallenge).not.toHaveBeenCalled();
  });
});

describe("POST /auth/verify validation", () => {
  it("issues a token for a valid signed challenge", async () => {
    const client = Keypair.random();
    h.prisma.user.upsert.mockResolvedValueOnce({
      id: "user_1",
      stellarPublicKey: client.publicKey(),
      displayName: "Tester",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: signedChallenge(client) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it("issues a session token whose jti is the redeemed challenge's hash", async () => {
    const client = Keypair.random();
    h.prisma.user.upsert.mockResolvedValueOnce({
      id: "user_jti",
      stellarPublicKey: client.publicKey(),
      displayName: "Tester",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const signed = signedChallenge(client);
    const challengeHash = new Transaction(signed, config.networkPassphrase).hash().toString("hex");

    const res = await inject({ method: "POST", url: "/auth/verify", payload: { transaction: signed } });

    expect(res.statusCode).toBe(200);
    const claims = jwt.decode(res.json().token) as jwt.JwtPayload;
    expect(claims).toMatchObject({
      sub: "user_jti",
      pk: client.publicKey(),
      iss: config.JWT_ISSUER,
      aud: config.JWT_AUDIENCE,
      jti: challengeHash,
    });
    expect(claims.exp! - claims.iat!).toBe(config.ACCESS_TOKEN_TTL_SECONDS);
  });

  it("accepts a home_domain that names the domain this server issues for", async () => {
    // The route compares the claim against `config.SEP10_HOME_DOMAIN`, which
    // the test environment derives from API_PUBLIC_URL as `localhost:4000` —
    // a value the request schema itself refuses. Pin a real domain so the
    // matching case is the one under test, not the shape of the default.
    config.SEP10_HOME_DOMAIN = "anchor.example.com";
    const client = Keypair.random();
    h.prisma.user.upsert.mockResolvedValueOnce({
      id: "user_2",
      stellarPublicKey: client.publicKey(),
      displayName: "Tester",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        transaction: signedChallenge(client),
        home_domain: "anchor.example.com",
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it("matches home_domain case-insensitively", async () => {
    config.SEP10_HOME_DOMAIN = "anchor.example.com";
    const client = Keypair.random();
    h.prisma.user.upsert.mockResolvedValueOnce({
      id: "user_3",
      stellarPublicKey: client.publicKey(),
      displayName: "Tester",
      avatarUrl: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        transaction: signedChallenge(client),
        home_domain: "ANCHOR.EXAMPLE.COM",
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a foreign home_domain without evaluating the credential", async () => {
    const client = Keypair.random();
    const transaction = signedChallenge(client);

    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction, home_domain: "other-anchor.example.com" },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code ?? body.error?.code).toBe("HOME_DOMAIN_MISMATCH");
    // The remedy is stated, so a misconfigured wallet integration is fixable
    // from the response alone instead of looking like a bad signature.
    expect(body.message ?? body.error?.message).toContain(config.SEP10_HOME_DOMAIN);
    expect(authenticateChallenge).not.toHaveBeenCalled();
    // Answered from the request, before the envelope was touched: the challenge
    // is still unredeemed, so the same signed envelope works once corrected.
    expect(h.consumed.size).toBe(0);
  });

  it.each(["client_domain", "clientDomain"])(
    "rejects %s outright instead of ignoring the claim",
    async (key) => {
      const client = Keypair.random();
      const transaction = signedChallenge(client);

      const res = await inject({
        method: "POST",
        url: "/auth/verify",
        payload: { transaction, [key]: "wallet.example.com" },
      });

      // This server performs no client-domain verification (src/services/sep10.ts
      // refuses an envelope carrying that operation), so accepting the field and
      // dropping it let a client believe it had authenticated one.
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.code ?? body.error?.code).toBe("CLIENT_DOMAIN_UNSUPPORTED");
      expect(authenticateChallenge).not.toHaveBeenCalled();
      expect(h.consumed.size).toBe(0);
    }
  );

  it.each([
    ["missing transaction", {}, "transaction"],
    ["null transaction", { transaction: null }, "transaction"],
    ["numeric transaction", { transaction: 7 }, "transaction"],
    ["empty transaction", { transaction: "" }, "transaction"],
    ["non-base64 transaction", { transaction: "not-xdr!" }, "transaction"],
    ["non-canonical base64", { transaction: "AB==" }, "transaction"],
    ["oversized transaction", { transaction: "A".repeat(50_004) }, "transaction"],
    ["invalid client_domain", { transaction: "AAAA", client_domain: "exam_ple.com" }, "client_domain"],
    ["invalid home_domain", { transaction: "AAAA", home_domain: "-anchor.example.com" }, "home_domain"],
  ])("rejects %s with 400 before verification", async (_label, payload, field) => {
    const res = await inject({ method: "POST", url: "/auth/verify", payload });
    expectValidationError(res, field);
    expect(authenticateChallenge).not.toHaveBeenCalled();
    expect(h.prisma.user.upsert).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown body field before consuming the challenge", async () => {
    const client = Keypair.random();
    const transaction = signedChallenge(client);
    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction, account: client.publicKey() },
    });
    expectValidationError(res);
    expect(authenticateChallenge).not.toHaveBeenCalled();
    // The challenge was not burned by the rejected request, so a corrected
    // retry with the same signed envelope still succeeds.
    expect(h.consumed.size).toBe(0);
  });

  it("rejects a query parameter", async () => {
    const res = await inject({
      method: "POST",
      url: "/auth/verify?transaction=AAAA",
      payload: { transaction: "AAAA" },
    });
    expectValidationError(res);
    expect(authenticateChallenge).not.toHaveBeenCalled();
  });

  it("rejects a request with no body", async () => {
    const res = await inject({ method: "POST", url: "/auth/verify" });
    expectValidationError(res);
    expect(authenticateChallenge).not.toHaveBeenCalled();
  });

  it("reports an unreachable challenge store as 503, not as a rejected credential", async () => {
    const client = Keypair.random();
    const transaction = signedChallenge(client);
    config.isTest = false;
    h.prisma.$executeRaw.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));

    const res = await inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction },
    });

    // Fails closed — the outage mints no session — but says so truthfully: a
    // 401 here would send the client re-signing against a dead store and would
    // hide an incident inside a wave of apparently bad credentials.
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code ?? body.error?.code).toBe("SERVICE_UNAVAILABLE");
    expect(body.message ?? body.error?.message).not.toContain("connection terminated");
    expect(body.token ?? body.error?.token).toBeUndefined();
    expect(h.prisma.user.upsert).not.toHaveBeenCalled();
  });
});
