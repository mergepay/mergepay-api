/**
 * Issue #540 — SEP-10 challenge validation: expiration and domain checks.
 *
 * The challenge envelope was already validated strictly (structure, home
 * domain, web auth domain, time bounds — see tests/sep10-hardening.test.ts).
 * What this issue adds is precision about *why* a valid-looking challenge is
 * rejected, so clients can distinguish the one failure they can fix without
 * debugging — expiry, remedied by requesting and signing a fresh challenge —
 * from signature and domain failures:
 *
 *  - Expired challenge  → 401 CHALLENGE_EXPIRED, message names the remedy.
 *  - Signature failure  → 401 UNAUTHORIZED with a message that points at the
 *                         signature, distinct from expiry.
 *  - Home-domain and other structural failures → generic 401 UNAUTHORIZED,
 *    deliberately opaque so rejections cannot be probed for which check fired.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  WebAuth,
} from "@stellar/stellar-sdk";

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

import {
  buildChallenge,
  verifyChallenge,
  serverKeypair,
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

describe("SEP-10 challenge validation (#540)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("expired challenges", () => {
    it("rejects an expired challenge with a precise CHALLENGE_EXPIRED error", async () => {
      vi.useFakeTimers();
      const { signedXdr } = validExchange();
      // Well past the challenge's own validity window plus the 30s skew
      // tolerance, so every expiry check below fires deterministically.
      vi.advanceTimersByTime(
        (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000
      );

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        status: 401,
        code: "CHALLENGE_EXPIRED",
      });
    });

    it("rejects an expired challenge with a message that names the remedy", async () => {
      vi.useFakeTimers();
      const { signedXdr } = validExchange();
      vi.advanceTimersByTime(
        (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000
      );

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        message:
          "Authentication challenge has expired. Request a new challenge and sign it promptly.",
      });
    });

    it("reports the challenge validity window in the error details", async () => {
      vi.useFakeTimers();
      const { signedXdr } = validExchange();
      vi.advanceTimersByTime(
        (CHALLENGE_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 1) * 1000
      );

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({
        details: { challengeValiditySeconds: CHALLENGE_VALIDITY_SECONDS },
      });
    });

    it("still accepts a challenge signed at the last moment inside the window", async () => {
      vi.useFakeTimers();
      const { client, signedXdr } = validExchange();
      // One second before the challenge's maxTime; well inside the skew
      // tolerance but a real test that the expiry boundary is not off-by-one
      // against the happy path.
      vi.advanceTimersByTime((CHALLENGE_VALIDITY_SECONDS - 1) * 1000);

      await expect(verifyChallenge(signedXdr)).resolves.toBe(client.publicKey());
    });
  });

  describe("home domain validation", () => {
    it("rejects a challenge built for a different home domain", async () => {
      const client = Keypair.random();
      const transaction = WebAuth.buildChallengeTx(
        serverKeypair(),
        client.publicKey(),
        "wrong-domain.example.com",
        CHALLENGE_VALIDITY_SECONDS,
        config.networkPassphrase,
        config.WEB_AUTH_DOMAIN
      );

      await expect(
        verifyChallenge(signAndEncode(client, transaction))
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    });

    it("does not leak the home-domain mismatch in the error message", async () => {
      const client = Keypair.random();
      const transaction = WebAuth.buildChallengeTx(
        serverKeypair(),
        client.publicKey(),
        "wrong-domain.example.com",
        CHALLENGE_VALIDITY_SECONDS,
        config.networkPassphrase,
        config.WEB_AUTH_DOMAIN
      );

      await expect(
        verifyChallenge(signAndEncode(client, transaction))
      ).rejects.toMatchObject({
        message: "Invalid or expired authentication challenge",
      });
    });

    it("rejects a challenge with a wrong web_auth_domain", async () => {
      const client = Keypair.random();
      const transaction = WebAuth.buildChallengeTx(
        serverKeypair(),
        client.publicKey(),
        config.SEP10_HOME_DOMAIN,
        CHALLENGE_VALIDITY_SECONDS,
        config.networkPassphrase,
        "wrong-web-auth.example.com"
      );

      await expect(
        verifyChallenge(signAndEncode(client, transaction))
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    });

    it("rejects a challenge built on the wrong network passphrase", async () => {
      const client = Keypair.random();
      const wrongNetwork =
        config.networkPassphrase === Networks.TESTNET
          ? Networks.PUBLIC
          : Networks.TESTNET;
      const transaction = WebAuth.buildChallengeTx(
        serverKeypair(),
        client.publicKey(),
        config.SEP10_HOME_DOMAIN,
        CHALLENGE_VALIDITY_SECONDS,
        wrongNetwork,
        config.WEB_AUTH_DOMAIN
      );

      await expect(
        verifyChallenge(signAndEncode(client, transaction))
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    });

    it("rejects a challenge naming the configured domain but with an empty nonce", async () => {
      const client = Keypair.random();
      const server = serverKeypair();
      const tx = new TransactionBuilder(new Account(server.publicKey(), "0"), {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          Operation.manageData({
            name: `${config.SEP10_HOME_DOMAIN} auth`,
            value: Buffer.alloc(0),
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
        .setTimebounds(
          Math.floor(Date.now() / 1000),
          Math.floor(Date.now() / 1000) + CHALLENGE_VALIDITY_SECONDS
        )
        .build();
      tx.sign(server, client);

      await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("invalid signatures", () => {
    it("rejects a challenge signed by a different account with a signature-specific message", async () => {
      const client = Keypair.random();
      const impostor = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());

      await expect(
        verifyChallenge(signAndEncode(impostor, transaction))
      ).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
        message:
          "Challenge signature verification failed. Ensure the challenge is signed by the account's signing key(s) before submitting.",
      });
    });

    it("rejects a challenge the client never signed with the signature-specific message", async () => {
      const client = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());

      // Server-signed only — the envelope is otherwise exactly what we issued.
      await expect(verifyChallenge(transaction)).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
        message:
          "Challenge signature verification failed. Ensure the challenge is signed by the account's signing key(s) before submitting.",
      });
    });

    it("never reports CHALLENGE_EXPIRED for a signature failure", async () => {
      const client = Keypair.random();
      const impostor = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());

      await expect(
        verifyChallenge(signAndEncode(impostor, transaction))
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(
        verifyChallenge(signAndEncode(impostor, transaction))
      ).rejects.not.toMatchObject({ code: "CHALLENGE_EXPIRED" });
    });

    it("rejects a challenge built by the wrong server account", async () => {
      const client = Keypair.random();
      const otherServer = Keypair.random();
      const transaction = WebAuth.buildChallengeTx(
        otherServer,
        client.publicKey(),
        config.SEP10_HOME_DOMAIN,
        CHALLENGE_VALIDITY_SECONDS,
        config.networkPassphrase,
        config.WEB_AUTH_DOMAIN
      );

      await expect(
        verifyChallenge(signAndEncode(client, transaction))
      ).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    });
  });

  describe("envelope hygiene", () => {
    it("rejects a malformed challenge string", async () => {
      await expect(verifyChallenge("not-a-real-xdr")).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
        message: "Invalid or expired authentication challenge",
      });
    });

    it("rejects an unrelated transaction envelope that is not a challenge", async () => {
      const client = Keypair.random();
      const server = serverKeypair();
      const tx = new TransactionBuilder(new Account(server.publicKey(), "1"), {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          Operation.payment({
            destination: client.publicKey(),
            asset: Asset.native(),
            amount: "1",
          })
        )
        .setTimeout(CHALLENGE_VALIDITY_SECONDS)
        .build();
      tx.sign(server, client);

      await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
    });

    it("rejects a challenge that is not valid yet", async () => {
      const client = Keypair.random();
      const server = serverKeypair();
      const start = Math.floor(Date.now() / 1000) + 600;

      const tx = new TransactionBuilder(new Account(server.publicKey(), "0"), {
        fee: BASE_FEE,
        networkPassphrase: config.networkPassphrase,
      })
        .addOperation(
          Operation.manageData({
            name: `${config.SEP10_HOME_DOMAIN} auth`,
            value: Buffer.from("0".repeat(48)),
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
        .setTimebounds(start, start + CHALLENGE_VALIDITY_SECONDS)
        .build();
      tx.sign(server, client);

      await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject({
        status: 401,
        code: "UNAUTHORIZED",
      });
    });

    it("still authenticates a correctly signed, in-window challenge", async () => {
      const { client, signedXdr } = validExchange();
      await expect(verifyChallenge(signedXdr)).resolves.toBe(
        client.publicKey()
      );
    });
  });
});
