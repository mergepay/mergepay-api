import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Transaction, WebAuth } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const store = new Set<string>();
  return {
    store,
    prisma: {
      sep10Challenge: {
        create: vi.fn(async ({ data }: any) => {
          if (store.has(data.fingerprint)) {
            const err: any = new Error("Unique constraint failed");
            err.code = "P2002";
            throw err;
          }
          store.add(data.fingerprint);
          return { id: "chal_1", ...data };
        }),
        deleteMany: vi.fn(async () => {
          const count = store.size;
          store.clear();
          return { count };
        }),
      },
    },
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

// Mock Horizon so the verify step treats the client account as unfunded
// (pure crypto verification against the master key — no network).
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

import { buildChallenge, verifyChallenge, cleanupExpiredChallenges, serverKeypair } from "../src/services/sep10";
import { config } from "../src/config";

describe("SEP-10 challenge / verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
  });

  it("builds a valid challenge transaction for an account", () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    expect(networkPassphrase).toBe(config.networkPassphrase);
    const tx = new Transaction(transaction, networkPassphrase);
    // A challenge is a 0-sequence tx with at least one manage_data op.
    expect(tx.sequence).toBe("0");
    expect(tx.operations.length).toBeGreaterThanOrEqual(1);
    expect(tx.operations[0].type).toBe("manageData");
  });

  it("verifies a correctly signed challenge and returns the client account id", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    const verified = await verifyChallenge(signedXdr);
    expect(verified).toBe(client.publicKey());
  });

  it("rejects a challenge that the client did not sign", async () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    // Not signed by the client.
    await expect(verifyChallenge(transaction)).rejects.toSatisfy(
      (err: any) => err.status === 401 || err.status === 400
    );
  });

  it("rejects a replayed challenge transaction", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    // First attempt succeeds
    const verified = await verifyChallenge(signedXdr);
    expect(verified).toBe(client.publicKey());

    // Second attempt fails due to replay
    await expect(verifyChallenge(signedXdr)).rejects.toSatisfy(
      (err: any) => err.code === "CHALLENGE_REPLAYED" || err.status === 400
    );
  });

  it("rejects an expired challenge transaction", async () => {
    const client = Keypair.random();
    const server = serverKeypair();
    // Build a challenge with maxTime in the past
    const expiredTx = WebAuth.buildChallengeTx(
      server,
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      -100,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );

    const tx = new Transaction(expiredTx, config.networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    await expect(verifyChallenge(signedXdr)).rejects.toSatisfy(
      (err: any) => err.code === "CHALLENGE_EXPIRED" || err.status === 400
    );
  });

  it("rejects a challenge created for a wrong server account", async () => {
    const client = Keypair.random();
    const wrongServer = Keypair.random();
    const wrongTx = WebAuth.buildChallengeTx(
      wrongServer,
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const tx = new Transaction(wrongTx, config.networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    await expect(verifyChallenge(signedXdr)).rejects.toSatisfy(
      (err: any) => err.code === "INVALID_CHALLENGE" || err.status === 400
    );
  });

  it("cleans up expired challenge records", async () => {
    const count = await cleanupExpiredChallenges();
    expect(count).toBeGreaterThanOrEqual(0);
    expect(h.prisma.sep10Challenge.deleteMany).toHaveBeenCalled();
  });
});
