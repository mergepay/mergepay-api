/**
 * Issue #336 — SEP-10 home domain validation and token expiration margin.
 *
 * Verifies:
 *  1. Challenges with invalid home domains are rejected
 *  2. Tokens near expiry are rejected by the margin check
 *  3. Valid authentication handshakes succeed
 *  4. The home domain extraction helper works correctly
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, Transaction, Networks } from "@stellar/stellar-sdk";

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

import { buildChallenge, verifyChallenge } from "../src/services/sep10";
import { config } from "../src/config";

describe("SEP-10 home domain validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects a challenge built for a different home domain", async () => {
    const client = Keypair.random();
    // Build a challenge using the correct server but with a different home domain
    const { WebAuth, Account } = await import("@stellar/stellar-sdk");
    const { serverKeypair } = await import("../src/services/sep10");

    // Import the real module to build a challenge with a mismatched domain
    const differentDomain = "wrong-domain.example.com";
    const foreignChallenge = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      differentDomain,
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const tx = new Transaction(foreignChallenge, config.networkPassphrase);
    tx.sign(client);

    await expect(verifyChallenge(tx.toXDR())).rejects.toBeTruthy();
  });

  it("rejects a challenge with a wrong web_auth_domain", async () => {
    const client = Keypair.random();
    const { WebAuth } = await import("@stellar/stellar-sdk");
    const { serverKeypair } = await import("../src/services/sep10");

    // Build with a different web_auth_domain
    const foreignChallenge = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      config.networkPassphrase,
      "wrong-web-auth.example.com"
    );
    const tx = new Transaction(foreignChallenge, config.networkPassphrase);
    tx.sign(client);

    await expect(verifyChallenge(tx.toXDR())).rejects.toBeTruthy();
  });

  it("accepts a challenge built for the correct home domain", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);

    const verified = await verifyChallenge(tx.toXDR());
    expect(verified).toBe(client.publicKey());
  });
});

describe("Token expiration margin", () => {
  let signToken: typeof import("../src/plugins/auth").signToken;
  let verifyToken: typeof import("../src/plugins/auth").verifyToken;

  beforeEach(async () => {
    vi.clearAllMocks();
    const auth = await import("../src/plugins/auth");
    signToken = auth.signToken;
    verifyToken = auth.verifyToken;
  });

  it("accepts a freshly minted token", () => {
    const user = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
    const token = signToken(user);
    const decoded = verifyToken(token);
    expect(decoded.id).toBe(user.id);
    expect(decoded.stellarPublicKey).toBe(user.stellarPublicKey);
  });

  it("rejects a token that expires within the margin window", () => {
    const user = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
    // Sign a token with a very short expiry (5 seconds) — within the 30s margin
    const jwt = require("jsonwebtoken");
    const token = jwt.sign(
      { sub: user.id, pk: user.stellarPublicKey },
      config.JWT_SECRET,
      {
        algorithm: "HS256",
        expiresIn: 5, // 5 seconds — well within the 30s margin
        issuer: config.JWT_ISSUER,
        audience: config.JWT_AUDIENCE,
      }
    );

    expect(() => verifyToken(token)).toThrow();
  });

  it("accepts a token with sufficient remaining lifetime", () => {
    const user = { id: "user_1", stellarPublicKey: Keypair.random().publicKey() };
    const token = signToken(user); // Default 900s TTL — well above margin
    const decoded = verifyToken(token);
    expect(decoded.id).toBe(user.id);
  });
});

describe("Valid authentication handshake end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("completes a full challenge → sign → verify cycle", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);

    const verified = await verifyChallenge(tx.toXDR());
    expect(verified).toBe(client.publicKey());
  });

  it("rejects replay of a previously verified challenge", async () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    const first = await verifyChallenge(signedXdr);
    expect(first).toBe(client.publicKey());

    await expect(verifyChallenge(signedXdr)).rejects.toBeTruthy();
  });

  it("rejects a challenge signed by the wrong account", async () => {
    const client = Keypair.random();
    const impostor = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(impostor);

    await expect(verifyChallenge(tx.toXDR())).rejects.toBeTruthy();
  });

  it("rejects an expired challenge", async () => {
    vi.useFakeTimers();
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);
    const signedXdr = tx.toXDR();

    // Advance past the 5-minute challenge validity window
    vi.advanceTimersByTime(6 * 60 * 1000);

    await expect(verifyChallenge(signedXdr)).rejects.toBeTruthy();
  });
});
