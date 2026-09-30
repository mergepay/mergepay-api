/**
 * Issue #709 — SEP-10 challenge transaction expiration validation and cleanup.
 *
 * Upstream had already layered challenge-expiry checks into envelope
 * validation (issues #540/#550). What #709 asks for on top:
 *
 *  1. The time-bound contract as an **explicit** validation step —
 *     `validateChallengeTimeBounds` — checked against server time with a
 *     bounded clock-skew tolerance, so every verification path provably
 *     passes through it and the rules are directly testable.
 *  2. **Distinct, client-actionable error responses** for each invalid
 *     window: CHALLENGE_EXPIRED (closed), CHALLENGE_NOT_YET_VALID (not yet
 *     open), CHALLENGE_WINDOW_TOO_LONG (outlives server validity) — verified
 *     here at the HTTP boundary on `POST /auth/verify`.
 *  3. **Cleanup checks**: the worker sweep purges rows whose validity window
 *     has closed, not only rows past the 24h retention (covered in
 *     tests/cleanup-challenges.test.ts).
 *
 * Time-bound scenarios are exercised through the real `buildChallenge` +
 * SDK signing path where possible, with fake timers shifting the server
 * clock after the challenge is built (like tests/sep10-challenge-validation.test.ts).
 * Hand-built variants cover windows the builder cannot produce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const store = new Map<string, number>();
  const prisma: Record<string, unknown> = {
    user: {
      upsert: vi.fn(async (args: {
        where: { stellarPublicKey: string };
        update: Record<string, never>;
        create: { stellarPublicKey: string; displayName: string };
      }) => ({
        id: "user-1",
        stellarPublicKey: args.where.stellarPublicKey,
        displayName: args.create.displayName,
        avatarUrl: null,
        createdAt: new Date(0),
      })),
    },
    auditLog: { create: vi.fn(async () => ({})) },
    refreshToken: {
      create: vi.fn(async () => ({
        token: "refresh-token",
        expiresAt: new Date(Date.now() + 86_400_000),
      })),
    },
    $executeRaw: vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
      const text = sql.strings.join("?");
      if (text.includes("INSERT INTO")) {
        const [fingerprint, expiresAt] = sql.values as [string, Date];
        if (store.has(fingerprint)) return 0;
        store.set(fingerprint, expiresAt.getTime());
        return 1;
      }
      return 0;
    }),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: unknown) =>
      typeof arg === "function" ? arg(prisma) : Promise.resolve(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { store, prisma };
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

import { buildApp } from "../src/app";
import {
  buildChallenge,
  parseTransaction,
  serverKeypair,
  validateChallengeTimeBounds,
  verifyChallenge,
  CHALLENGE_VALIDITY_SECONDS,
} from "../src/services/sep10";
import { config } from "../src/config";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../src/lib/time-bounds";

function signAndEncode(client: Keypair, transaction: string): string {
  const tx = new Transaction(transaction, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

/** A fresh challenge for a fresh client, signed by that client. */
function validExchange(): { client: Keypair; signedXdr: string } {
  const client = Keypair.random();
  const { transaction } = buildChallenge(client.publicKey());
  return { client, signedXdr: signAndEncode(client, transaction) };
}

/**
 * Hand-build a challenge with exact time bounds and sign it with server +
 * client keys, so each rejection is attributable to the window alone.
 */
function challengeWithBounds(
  client: Keypair,
  bounds: { minTime: number; maxTime: number }
): string {
  const server = serverKeypair();
  const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
    timebounds: bounds,
  })
    .addOperation(
      Operation.manageData({
        name: `${config.SEP10_HOME_DOMAIN} auth`,
        value: Buffer.alloc(48, 7).toString("base64"),
        source: client.publicKey(),
      })
    )
    .addOperation(
      Operation.manageData({
        name: "web_auth_domain",
        value: Buffer.from(config.WEB_AUTH_DOMAIN),
        source: server.publicKey(),
      })
    )
    .build();
  tx.sign(server, client);
  return tx.toXDR();
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.store.clear();
  if (!app) app = await buildApp();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Unit: validateChallengeTimeBounds ───────────────────────────────────────

describe("validateChallengeTimeBounds (unit)", () => {
  const NOW = new Date("2026-09-26T14:00:00.000Z");
  const nowS = Math.floor(NOW.getTime() / 1000);

  it("accepts a window that spans the current server time", () => {
    expect(() =>
      validateChallengeTimeBounds(
        { minTime: nowS - 10, maxTime: nowS + CHALLENGE_VALIDITY_SECONDS },
        NOW
      )
    ).not.toThrow();
  });

  it("rejects a challenge whose maxTime has elapsed", () => {
    // maxTime 31s ago: past the 30s skew tolerance, so genuinely expired.
    expect(() =>
      validateChallengeTimeBounds(
        { minTime: nowS - CHALLENGE_VALIDITY_SECONDS, maxTime: nowS - 31 },
        NOW
      )
    ).toThrow(
      expect.objectContaining({ code: "CHALLENGE_EXPIRED", status: 401 })
    );
  });

  it("rejects a challenge whose minTime has not been reached", () => {
    expect(() =>
      validateChallengeTimeBounds(
        { minTime: nowS + 120, maxTime: nowS + 120 + CHALLENGE_VALIDITY_SECONDS },
        NOW
      )
    ).toThrow(
      expect.objectContaining({ code: "CHALLENGE_NOT_YET_VALID", status: 401 })
    );
  });

  it("rejects a window longer than the validity this server issues", () => {
    expect(() =>
      validateChallengeTimeBounds(
        { minTime: nowS, maxTime: nowS + 3600 },
        NOW
      )
    ).toThrow(
      expect.objectContaining({ code: "CHALLENGE_WINDOW_TOO_LONG", status: 401 })
    );
  });

  it("rejects missing or unbounded windows", () => {
    expect(() => validateChallengeTimeBounds(null, NOW)).toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" })
    );
    expect(() =>
      validateChallengeTimeBounds({ minTime: 0, maxTime: 0 }, NOW)
    ).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
  });  it("grants the clock-skew tolerance past maxTime", () => {
    expect(() =>
      validateChallengeTimeBounds(
        {
          minTime: nowS - CHALLENGE_VALIDITY_SECONDS,
          maxTime: nowS - CLOCK_SKEW_TOLERANCE_SECONDS + 1,
        },
        NOW
      )
    ).not.toThrow();
  });

  it("rejects maxTime exactly at the skew boundary (comparison is inclusive)", () => {
    // maxTime + skew == now is already expired: the tolerance absorbs clock
    // disagreement, it does not extend the window a full skew further.
    expect(() =>
      validateChallengeTimeBounds(
        {
          minTime: nowS - CHALLENGE_VALIDITY_SECONDS,
          maxTime: nowS - CLOCK_SKEW_TOLERANCE_SECONDS,
        },
        NOW
      )
    ).toThrow(expect.objectContaining({ code: "CHALLENGE_EXPIRED" }));
  });

  it("grants the clock-skew tolerance before minTime", () => {
    expect(() =>
      validateChallengeTimeBounds(
        {
          minTime: nowS + CLOCK_SKEW_TOLERANCE_SECONDS,
          maxTime: nowS + CLOCK_SKEW_TOLERANCE_SECONDS + CHALLENGE_VALIDITY_SECONDS,
        },
        NOW
      )
    ).not.toThrow();
  });

  it("rejects minTime exactly one second past the skew boundary", () => {
    expect(() =>
      validateChallengeTimeBounds(
        {
          minTime: nowS + CLOCK_SKEW_TOLERANCE_SECONDS + 1,
          maxTime: nowS + CLOCK_SKEW_TOLERANCE_SECONDS + 1 + CHALLENGE_VALIDITY_SECONDS,
        },
        NOW
      )
    ).toThrow(expect.objectContaining({ code: "CHALLENGE_NOT_YET_VALID" }));
  });

  it("allows a window of exactly the issued validity", () => {
    expect(() =>
      validateChallengeTimeBounds(
        { minTime: nowS, maxTime: nowS + CHALLENGE_VALIDITY_SECONDS },
        NOW
      )
    ).not.toThrow();
  });
});

// ─── Service path: verifyChallenge ───────────────────────────────────────────

describe("challenge time-bound verification (#709)", () => {
  it("rejects an expired challenge through the verify path", async () => {
    vi.useFakeTimers();
    const { signedXdr } = validExchange();
    vi.advanceTimersByTime(
      (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000
    );

    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
      status: 401,
      code: "CHALLENGE_EXPIRED",
    });
  });

  it("rejects a challenge whose window has not opened yet with its own code", async () => {
    const client = Keypair.random();
    const start = Math.floor(Date.now() / 1000) + 120; // beyond skew tolerance
    const signedXdr = challengeWithBounds(client, {
      minTime: start,
      maxTime: start + CHALLENGE_VALIDITY_SECONDS,
    });

    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
      status: 401,
      code: "CHALLENGE_NOT_YET_VALID",
    });
  });

  it("rejects a window longer than the server-issued validity with its own code", async () => {
    const client = Keypair.random();
    const nowS = Math.floor(Date.now() / 1000);
    const signedXdr = challengeWithBounds(client, {
      minTime: nowS,
      maxTime: nowS + 3600,
    });

    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
      status: 401,
      code: "CHALLENGE_WINDOW_TOO_LONG",
    });
  });

  it("still accepts a challenge inside the skew tolerance past maxTime", async () => {
    vi.useFakeTimers();
    const { client, signedXdr } = validExchange();
    vi.advanceTimersByTime(
      (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS - 5) * 1000
    );

    await expect(verifyChallenge(signedXdr)).resolves.toBe(client.publicKey());
  });

  it("records the single-use record until maxTime plus skew, not just validity", async () => {
    vi.useFakeTimers();
    const { signedXdr } = validExchange();
    // Redeem inside the window.
    vi.advanceTimersByTime((CHALLENGE_VALIDITY_SECONDS - 5) * 1000);
    await expect(verifyChallenge(signedXdr)).resolves.toBeDefined();
    const [fingerprint, expiresAt] = [...h.store.entries()][0];
    // The replay record must outlive the envelope's own redeemable window
    // (maxTime + skew), not merely the nominal validity.
    expect(expiresAt).toBeGreaterThan(
      Date.now() + CLOCK_SKEW_TOLERANCE_SECONDS * 1000
    );
    expect(fingerprint).toHaveLength(64);
  });
});

// ─── HTTP boundary: POST /auth/verify error responses ────────────────────────

describe("POST /auth/verify time-bound error responses (#709)", () => {
  it("returns 401 CHALLENGE_EXPIRED for an expired challenge", async () => {
    // Built with a window that closed minutes ago (beyond the SDK's own 300s
    // grace), so no fake timers are needed — Fastify's inject requires real
    // ones. The server-signed envelope earns the precise temporal code.
    const client = Keypair.random();
    const nowS = Math.floor(Date.now() / 1000);
    const signedXdr = challengeWithBounds(client, {
      minTime: nowS - 1000,
      maxTime: nowS - 500,
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: signedXdr },
      remoteAddress: "10.60.0.1",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code ?? body.error?.code).toBe("CHALLENGE_EXPIRED");
    expect(body.message ?? body.error?.message).toBe(
      "Authentication challenge has expired. Request a new challenge and sign it promptly."
    );
  });

  it("returns 401 CHALLENGE_NOT_YET_VALID for a challenge whose window has not opened", async () => {
    const client = Keypair.random();
    const start = Math.floor(Date.now() / 1000) + 120;
    const signedXdr = challengeWithBounds(client, {
      minTime: start,
      maxTime: start + CHALLENGE_VALIDITY_SECONDS,
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: signedXdr },
      remoteAddress: "10.60.0.2",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code ?? body.error?.code).toBe("CHALLENGE_NOT_YET_VALID");
    expect(body.message ?? body.error?.message).toContain("not valid yet");
  });

  it("returns 401 CHALLENGE_WINDOW_TOO_LONG for an over-long window", async () => {
    const client = Keypair.random();
    const nowS = Math.floor(Date.now() / 1000);
    const signedXdr = challengeWithBounds(client, {
      minTime: nowS,
      maxTime: nowS + 3600,
    });

    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: signedXdr },
      remoteAddress: "10.60.0.3",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code ?? body.error?.code).toBe("CHALLENGE_WINDOW_TOO_LONG");
  });

  it("keeps a signature failure on the generic UNAUTHORIZED while windows get their own codes", async () => {
    // A challenge with an over-long window AND an invalid signature: the
    // structural failure must win the response, never a temporal code.
    const client = Keypair.random();
    const impostor = Keypair.random();
    const nowS = Math.floor(Date.now() / 1000);
    const server = serverKeypair();
    const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
      timebounds: { minTime: nowS, maxTime: nowS + 3600 },
    })
      .addOperation(
        Operation.manageData({
          name: `${config.SEP10_HOME_DOMAIN} auth`,
          value: Buffer.alloc(48, 7).toString("base64"),
          source: client.publicKey(),
        })
      )
      .addOperation(
        Operation.manageData({
          name: "web_auth_domain",
          value: Buffer.from(config.WEB_AUTH_DOMAIN),
          source: server.publicKey(),
        })
      )
      .build();
    tx.sign(impostor);

    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: tx.toXDR() },
      remoteAddress: "10.60.0.4",
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.code ?? body.error?.code).toBe("UNAUTHORIZED");
  });

  it("builds challenges with a window that passes its own validation now", async () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const tx = parseTransaction(transaction);
    const bounds = tx.timeBounds;

    expect(bounds).toBeDefined();
    expect(Number(bounds!.maxTime) - Number(bounds!.minTime)).toBe(
      CHALLENGE_VALIDITY_SECONDS
    );
    expect(() => validateChallengeTimeBounds({
      minTime: Number(bounds!.minTime),
      maxTime: Number(bounds!.maxTime),
    })).not.toThrow();
  });
});
