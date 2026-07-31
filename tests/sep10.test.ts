import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Transaction, Networks } from "@stellar/stellar-sdk";

// A fake `Sep10ConsumedChallenge` table backing $executeRaw, so consumeChallenge()
// exercises its real INSERT ... ON CONFLICT / DELETE raw-SQL path instead of the
// in-memory fallback meant only for db mocks that don't implement $executeRaw.
const h = vi.hoisted(() => {
  const store = new Map<string, number>();
  const executeRaw = vi.fn(async (sql: { strings: string[]; values: unknown[] }) => {
    const text = sql.strings.join("?");
    if (text.includes("INSERT INTO")) {
      const [id, expiresAt] = sql.values as [string, Date];
      if (store.has(id)) return 0;
      store.set(id, expiresAt.getTime());
      return 1;
    }
    if (text.includes("DELETE FROM")) {
      const now = Date.now();
      let deleted = 0;
      for (const [key, expiresAt] of store) {
        if (expiresAt <= now) {
          store.delete(key);
          deleted += 1;
        }
      }
      return deleted;
    }
    return 0;
  });
  return { store, executeRaw };
});

vi.mock("../src/db", () => ({
  prisma: { $executeRaw: h.executeRaw },
}));

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

  afterEach(() => {
    vi.useRealTimers();
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

  it("rejects a challenge request for a malformed account", () => {
    expect(() => buildChallenge("not-a-key")).toThrow();
  });

  it("verifies a correctly signed, valid challenge and returns the client account id", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    const verified = await verifyChallenge(signedXdr);
    expect(verified).toBe(client.publicKey());
  });

  it("rejects a challenge that the client did not sign (wrong-client)", async () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    // Not signed by the client at all.
    await expect(verifyChallenge(transaction)).rejects.toBeTruthy();
  });

  it("rejects a challenge signed by a different account than the one it names (wrong-client)", async () => {
    const client = Keypair.random();
    const impostor = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());

    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(impostor); // signed, but not by the account the challenge was issued to
    await expect(verifyChallenge(tx.toXDR())).rejects.toBeTruthy();
  });

  it("rejects an expired challenge", async () => {
    vi.useFakeTimers();
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    // Past the challenge's validity window (5 minutes).
    vi.advanceTimersByTime(6 * 60 * 1000);

    await expect(verifyChallenge(signedXdr)).rejects.toBeTruthy();
  });

  it("rejects a challenge signed for the wrong network", async () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());

    // Sign against a different network passphrase than the server expects —
    // the signature is computed over network-passphrase-dependent bytes, so
    // this invalidates it even though the XDR structure is unchanged.
    const wrongNetwork =
      config.networkPassphrase === Networks.TESTNET ? Networks.PUBLIC : Networks.TESTNET;
    const tx = new Transaction(transaction, wrongNetwork);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    await expect(verifyChallenge(signedXdr)).rejects.toBeTruthy();
  });

  it("rejects a challenge built with a different server signing key (wrong-server)", async () => {
    // Simulate an attacker (or a different anchor) building a well-formed
    // SEP-10 challenge naming our client but signed with a server key our
    // deployment does not recognize.
    const client = Keypair.random();
    const otherServer = Keypair.random();
    const { WebAuth } = await import("@stellar/stellar-sdk");
    const foreignChallenge = WebAuth.buildChallengeTx(
      otherServer,
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const tx = new Transaction(foreignChallenge, config.networkPassphrase);
    tx.sign(client);
    await expect(verifyChallenge(tx.toXDR())).rejects.toBeTruthy();
  });

  it("rejects replaying the same signed challenge a second time", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    const first = await verifyChallenge(signedXdr);
    expect(first).toBe(client.publicKey());

    // The exact same signed transaction, exchanged again.
    await expect(verifyChallenge(signedXdr)).rejects.toBeTruthy();
  });

  it("claims the challenge exactly once under concurrent verification attempts", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    const results = await Promise.allSettled([
      verifyChallenge(signedXdr),
      verifyChallenge(signedXdr),
      verifyChallenge(signedXdr),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
  });

  it("does not error on a provider unavailable for an unrelated (already-expired) row during cleanup", async () => {
    // Sanity check that the opportunistic cleanup DELETE inside
    // consumeChallenge doesn't interfere with claiming a fresh challenge.
    h.store.set("stale-id", Date.now() - 1000);
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);

    const verified = await verifyChallenge(tx.toXDR());
    expect(verified).toBe(client.publicKey());
    expect(h.store.has("stale-id")).toBe(false);
  });
});
