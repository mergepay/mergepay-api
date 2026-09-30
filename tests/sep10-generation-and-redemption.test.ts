/**
 * SEP-10 challenge generation and single-use redemption (#362).
 *
 * The sibling specs hand-assemble envelopes to pin everything `verifyChallenge`
 * rejects (#540/#550/#709). This suite covers the two halves of the same
 * contract they never reach:
 *
 *  - **Generation** — which key actually signs. `serverKeypair` reads
 *    `SEP10_SIGNING_SECRET` once and caches it, so an unset secret means every
 *    instance invents its own server account. Nothing pinned that the
 *    configured key is the account clients must authenticate against.
 *  - **Redemption** — the durable `Sep10Challenge` row is what production
 *    writes. Its P2002 replay signal, its fail-closed behaviour when the store
 *    errors, and `cleanupExpiredChallenges()` had no coverage at all.
 *
 * Challenges are produced by `buildChallenge` and signed the way a wallet
 * signs them — parse the envelope, add the client signature, re-emit — so
 * generation and verification are exercised as one pair. The redemption store
 * is dialed per case because the service picks it by which of
 * `prisma.sep10Challenge.create` and `prisma.$executeRaw` exist.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { Keypair, StrKey, Transaction, WebAuth } from "@stellar/stellar-sdk";
import { Prisma } from "@prisma/client";

const h = vi.hoisted(() => ({
  loadAccount: vi.fn(),
  create: vi.fn(),
  deleteMany: vi.fn(),
  executeRaw: vi.fn(),
}));

/**
 * The service reads `prisma.sep10Challenge` / `prisma.$executeRaw` at call
 * time, so tests can wire and unwire the durable surface between cases.
 */
const prismaMock = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock("../src/db", () => ({ prisma: prismaMock }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: { ...actual.stellar, loadAccount: h.loadAccount },
  };
});

import {
  authenticateChallenge,
  buildChallenge,
  cleanupExpiredChallenges,
  serverKeypair,
  verifyChallenge,
} from "../src/services/sep10";
import { config } from "../src/config";
import { AppError } from "../src/errors";
import { CLOCK_SKEW_TOLERANCE_SECONDS } from "../src/lib/time-bounds";

const T0 = new Date("2026-09-29T12:00:00.000Z");
const UNAUTHORIZED = { status: 401, code: "UNAUTHORIZED" };
const UNFUNDED = {
  exists: false,
  sequence: "0",
  balances: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
};

const IS_TEST = config.isTest;

/** A wallet's move: take the issued envelope, add our signature, hand it back. */
function signAsClient(challengeXdr: string, client: Keypair): string {
  const tx = new Transaction(challengeXdr, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

/** Build through the service and sign with `client`, as the real flow does. */
function signedChallenge(client: Keypair): string {
  return signAsClient(buildChallenge(client.publicKey()).transaction, client);
}

function p2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`fingerprint`)",
    { code: "P2002", clientVersion: "5.18.0" }
  );
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.loadAccount.mockReset().mockResolvedValue(UNFUNDED);
  h.create.mockReset();
  h.deleteMany.mockReset();
  h.executeRaw.mockReset();
  delete prismaMock.sep10Challenge;
  delete prismaMock.$executeRaw;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  config.isTest = IS_TEST;
});

describe("SEP-10 challenge generation — the signing key", () => {
  it("signs challenges with the key configured in SEP10_SIGNING_SECRET", async () => {
    const secret = Keypair.random().secret();
    vi.resetModules();
    vi.stubEnv("SEP10_SIGNING_SECRET", secret);

    const sep10 = await import("../src/services/sep10");
    const server = sep10.serverKeypair();

    expect(server.publicKey()).toBe(Keypair.fromSecret(secret).publicKey());
    // Read once and cached: a second call must not mint a different account.
    expect(sep10.serverKeypair()).toBe(server);

    const client = Keypair.random();
    const { transaction, networkPassphrase } = sep10.buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);

    expect(tx.source).toBe(server.publicKey());
    expect(WebAuth.verifyTxSignedBy(tx, server.publicKey())).toBe(true);

    // The account this key signs for is the account verification accepts.
    const walletXdr = signAsClient(transaction, client);
    await expect(sep10.verifyChallenge(walletXdr)).resolves.toBe(client.publicKey());
  });

  it("authenticates a challenge whose server signature comes from the configured key", async () => {
    const secret = Keypair.random().secret();
    vi.resetModules();
    vi.stubEnv("SEP10_SIGNING_SECRET", secret);

    const sep10 = await import("../src/services/sep10");
    const client = Keypair.random();
    const xdr = signAsClient(sep10.buildChallenge(client.publicKey()).transaction, client);

    const verified = await sep10.authenticateChallenge(xdr);
    expect(verified.account).toBe(client.publicKey());
    expect(verified.challengeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("mints an ephemeral server account when no signing secret is configured", async () => {
    vi.resetModules();
    vi.stubEnv("SEP10_SIGNING_SECRET", "");

    const sep10 = await import("../src/services/sep10");
    const first = sep10.serverKeypair();

    expect(StrKey.isValidEd25519PublicKey(first.publicKey())).toBe(true);
    expect(sep10.serverKeypair().publicKey()).toBe(first.publicKey());

    // A second process (module instance) invents a *different* account, which
    // is exactly why a deployment cannot rely on the fallback: challenges
    // issued by one instance are unverifiable by the next.
    vi.resetModules();
    const second = (await import("../src/services/sep10")).serverKeypair();
    expect(second.publicKey()).not.toBe(first.publicKey());
  });
});

describe("SEP-10 redemption through the durable Sep10Challenge row", () => {
  function withCreateModel() {
    prismaMock.sep10Challenge = { create: h.create };
    h.create.mockResolvedValue({ id: "ch_1" });
  }

  it("claims the challenge by inserting one row keyed on the envelope hash", async () => {
    withCreateModel();
    const client = Keypair.random();
    const xdr = signedChallenge(client);

    await expect(verifyChallenge(xdr)).resolves.toBe(client.publicKey());

    expect(h.create).toHaveBeenCalledTimes(1);
    // The model path returns immediately: no raw-SQL fallback for this write.
    expect(h.executeRaw).not.toHaveBeenCalled();

    const { data } = h.create.mock.calls[0][0] as {
      data: { fingerprint: string; clientAccount: string; expiresAt: Date };
    };
    expect(data.clientAccount).toBe(client.publicKey());

    // Fingerprint is sha256 over the transaction hash, i.e. the same identity
    // the session `jti` carries — two verifications of one envelope collide.
    const tx = new Transaction(xdr, config.networkPassphrase);
    expect(data.fingerprint).toBe(
      createHash("sha256").update(tx.hash()).digest("hex")
    );
  });

  it("keeps the row alive until the envelope can no longer be redeemed", async () => {
    withCreateModel();
    const client = Keypair.random();
    const xdr = signedChallenge(client);
    await verifyChallenge(xdr);

    const { expiresAt } = h.create.mock.calls[0][0].data as { expiresAt: Date };
    const maxTime = Number(new Transaction(xdr, config.networkPassphrase).timeBounds?.maxTime);

    // maxTime + the skew the verifier grants + 1s: expiring it any earlier
    // would let the sweep delete the row while the same signature still
    // redeems — the replay window reopening.
    expect(expiresAt.getTime()).toBe((maxTime + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000);
  });

  it("rejects a second verification as a replay when the store reports P2002", async () => {
    prismaMock.sep10Challenge = { create: h.create };
    const client = Keypair.random();
    const xdr = signedChallenge(client);

    h.create.mockResolvedValueOnce({ id: "ch_1" }).mockRejectedValueOnce(p2002());

    await expect(verifyChallenge(xdr)).resolves.toBe(client.publicKey());
    const reason = await verifyChallenge(xdr).catch((e: unknown) => e);
    expect(reason).toMatchObject(UNAUTHORIZED);
    if (!(reason instanceof AppError)) {
      throw new Error(`expected the replay to reject with an AppError, got ${String(reason)}`);
    }
    // A replay is a structural failure, never dressed up as expiry.
    expect(reason.code).not.toBe("CHALLENGE_EXPIRED");
    expect(h.create).toHaveBeenCalledTimes(2);
  });

  it("lets exactly one of two concurrent verifications of one envelope win", async () => {
    const client = Keypair.random();
    const xdr = signedChallenge(client);
    const claimed = new Set<string>();
    prismaMock.sep10Challenge = {
      create: vi.fn(async (args: { data: { fingerprint: string } }) => {
        if (claimed.has(args.data.fingerprint)) throw p2002();
        claimed.add(args.data.fingerprint);
        return { id: "ch_1" };
      }),
    };

    const results = await Promise.allSettled([verifyChallenge(xdr), verifyChallenge(xdr)]);

    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    // The insert is the concurrency control, so there is no read-then-write
    // gap for a second request to slip through.
    expect(lost[0]).toMatchObject({ reason: UNAUTHORIZED });
  });

  it("never writes a redemption row for a challenge that failed verification", async () => {
    withCreateModel();
    const client = Keypair.random();
    // Issued but never signed by the client.
    const unsigned = buildChallenge(client.publicKey()).transaction;

    await expect(verifyChallenge(unsigned)).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(h.create).not.toHaveBeenCalled();
    // A failed attempt cannot burn someone else's pending challenge.
    await expect(verifyChallenge(signAsClient(unsigned, client))).resolves.toBe(
      client.publicKey()
    );
  });

  it("fails closed when the store errors and no test fallback is available", async () => {
    prismaMock.sep10Challenge = { create: h.create };
    // Wire the raw-SQL path too. Without the fail-closed guard on the model
    // branch, verification would slide into it and redeem the challenge
    // anyway, so its absence is what this case actually proves.
    prismaMock.$executeRaw = h.executeRaw;
    h.executeRaw.mockResolvedValue(1);
    h.create.mockRejectedValue(new Error("connection terminated unexpectedly"));
    config.isTest = false;
    const client = Keypair.random();
    const xdr = signedChallenge(client);

    // A database outage must never become an authentication bypass.
    await expect(verifyChallenge(xdr)).rejects.toMatchObject(UNAUTHORIZED);
    expect(h.executeRaw).not.toHaveBeenCalled();
  });

  it("still enforces single use when the store errors under test", async () => {
    prismaMock.sep10Challenge = { create: h.create };
    h.create.mockRejectedValue(new Error("simulated store outage"));
    const client = Keypair.random();
    const xdr = signedChallenge(client);

    // Under test the write falls through to the documented in-process store,
    // which holds the same single-use guarantee.
    await expect(verifyChallenge(xdr)).resolves.toBe(client.publicKey());
    await expect(verifyChallenge(xdr)).rejects.toMatchObject(UNAUTHORIZED);
  });
});

describe("SEP-10 redemption when only raw SQL is available", () => {
  beforeEach(() => {
    prismaMock.$executeRaw = h.executeRaw;
  });

  it("rethrows an AppError from the store instead of collapsing it to a generic 401", async () => {
    const boom = new AppError(503, "CHALLENGE_STORE_UNAVAILABLE", "challenge store is down");
    h.executeRaw.mockRejectedValue(boom);
    const client = Keypair.random();

    await expect(verifyChallenge(signedChallenge(client))).rejects.toBe(boom);
  });

  it("fails closed on a non-AppError store failure outside test mode", async () => {
    h.executeRaw.mockRejectedValue(new Error("too many connections"));
    config.isTest = false;
    const client = Keypair.random();

    await expect(verifyChallenge(signedChallenge(client))).rejects.toMatchObject(UNAUTHORIZED);
  });
});

describe("cleanupExpiredChallenges", () => {
  it("reports nothing deleted when no durable model is wired", async () => {
    await expect(cleanupExpiredChallenges()).resolves.toBe(0);

    prismaMock.sep10Challenge = {};
    await expect(cleanupExpiredChallenges()).resolves.toBe(0);
  });

  it("deletes rows whose window has closed and reports the count", async () => {
    prismaMock.sep10Challenge = { deleteMany: h.deleteMany };
    h.deleteMany.mockResolvedValue({ count: 7 });

    await expect(cleanupExpiredChallenges()).resolves.toBe(7);
    const args = h.deleteMany.mock.calls[0][0] as {
      where: { expiresAt: { lt: Date } };
    };
    expect(Object.keys(args.where)).toEqual(["expiresAt"]);
    expect(args.where.expiresAt.lt).toBeInstanceOf(Date);
    expect(args.where.expiresAt.lt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("does not sweep a redemption row while its challenge is still redeemable", async () => {
    prismaMock.sep10Challenge = { create: h.create, deleteMany: h.deleteMany };
    h.create.mockResolvedValue({ id: "ch_1" });
    h.deleteMany.mockResolvedValue({ count: 0 });

    const client = Keypair.random();
    await verifyChallenge(signedChallenge(client));
    const stored = (h.create.mock.calls[0][0].data as { expiresAt: Date }).expiresAt;

    // Mid-window: the sweep's cutoff sits behind the row, so the record — and
    // with it replay protection — survives.
    vi.setSystemTime(new Date(T0.getTime() + 100_000));
    await cleanupExpiredChallenges();
    const midWindow = h.deleteMany.mock.calls[0][0].where.expiresAt.lt as Date;
    expect(midWindow.getTime()).toBeLessThan(stored.getTime());

    // Once the envelope is past its own expiry plus skew, the cutoff has passed
    // the row and it becomes collectable.
    h.deleteMany.mockClear();
    vi.setSystemTime(new Date(stored.getTime() + 1_000));
    await cleanupExpiredChallenges();
    const afterWindow = h.deleteMany.mock.calls[0][0].where.expiresAt.lt as Date;
    expect(afterWindow.getTime()).toBeGreaterThan(stored.getTime());
  });
});
