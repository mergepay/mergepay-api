import { describe, it, expect, vi, beforeEach } from "vitest";
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

// No database in these tests: the challenge store falls back to its in-process
// replay guard, which is the documented test-only path (production fails closed
// when the durable store is unreachable — see src/services/sep10.ts).
vi.mock("../src/db", () => ({ prisma: {} }));

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

const unauthorized = { status: 401 };

describe("SEP-10 verification", () => {
  beforeEach(() => vi.clearAllMocks());

  // -- the happy path --------------------------------------------------------

  it("authenticates a correctly signed, in-window challenge", async () => {
    const { client, signedXdr } = validExchange();
    await expect(verifyChallenge(signedXdr)).resolves.toBe(client.publicKey());
  });

  it("issues a challenge that is unsubmittable and bound to the client", () => {
    const client = Keypair.random();
    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);

    expect(networkPassphrase).toBe(config.networkPassphrase);
    expect(tx.sequence).toBe("0");
    expect(tx.source).toBe(serverKeypair().publicKey());
    expect(tx.operations[0].type).toBe("manageData");
    expect(tx.operations[0].source).toBe(client.publicKey());
  });

  it("rejects a challenge request for a malformed account", () => {
    expect(() => buildChallenge("not-a-key")).toThrow();
  });

  // -- wrong network / domains / accounts -----------------------------------

  it("rejects a challenge built on the wrong network passphrase", async () => {
    const client = Keypair.random();
    const wrongNetwork =
      config.networkPassphrase === Networks.TESTNET ? Networks.PUBLIC : Networks.TESTNET;
    const transaction = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      CHALLENGE_VALIDITY_SECONDS,
      wrongNetwork,
      config.WEB_AUTH_DOMAIN
    );
    const tx = new Transaction(transaction, wrongNetwork);
    tx.sign(client);

    await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject(unauthorized);
  });

  it("rejects a challenge built for the wrong home domain", async () => {
    const client = Keypair.random();
    const transaction = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      "not-the-configured-domain.example",
      CHALLENGE_VALIDITY_SECONDS,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );

    await expect(
      verifyChallenge(signAndEncode(client, transaction))
    ).rejects.toMatchObject(unauthorized);
  });

  it("rejects a challenge built for the wrong web auth domain", async () => {
    const client = Keypair.random();
    const transaction = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      CHALLENGE_VALIDITY_SECONDS,
      config.networkPassphrase,
      "auth.somewhere-else.example"
    );

    await expect(
      verifyChallenge(signAndEncode(client, transaction))
    ).rejects.toMatchObject(unauthorized);
  });

  it("rejects a challenge signed by a different server account", async () => {
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
    ).rejects.toMatchObject(unauthorized);
  });

  it("rejects a challenge signed by an account other than the one it names", async () => {
    const client = Keypair.random();
    const impostor = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());

    await expect(
      verifyChallenge(signAndEncode(impostor, transaction))
    ).rejects.toMatchObject(unauthorized);
  });

  it("rejects a challenge the client never signed", async () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());

    // The server signature alone proves nothing about the client.
    await expect(verifyChallenge(transaction)).rejects.toMatchObject(unauthorized);
  });

  // -- time bounds -----------------------------------------------------------

  it("rejects an expired challenge", async () => {
    // The SDK grants a clock-skew grace period past a challenge's own timeout,
    // so jump the clock forward rather than waiting for real time to pass.
    vi.useFakeTimers();
    try {
      const { signedXdr } = validExchange();
      vi.advanceTimersByTime((CHALLENGE_VALIDITY_SECONDS + 301) * 1000);

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject(unauthorized);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a challenge that is not valid yet", async () => {
    const client = Keypair.random();
    const server = serverKeypair();
    const start = Math.floor(Date.now() / 1000) + 600;

    const tx = new TransactionBuilder(new Account(server.publicKey(), "-1"), {
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

    await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject(unauthorized);
  });

  // -- malformed and unrelated envelopes ------------------------------------

  it("rejects a malformed challenge string", async () => {
    await expect(verifyChallenge("not-a-real-xdr")).rejects.toMatchObject(unauthorized);
  });

  it("rejects an unrelated transaction envelope", async () => {
    const client = Keypair.random();
    const server = serverKeypair();

    // A perfectly valid payment, signed by both parties — but not a challenge.
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

    await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject(unauthorized);
  });

  // -- replay ----------------------------------------------------------------

  it("rejects replay of an already-consumed signed challenge", async () => {
    const { client, signedXdr } = validExchange();

    await expect(verifyChallenge(signedXdr)).resolves.toBe(client.publicKey());
    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject(unauthorized);
  });

  it("consumes a challenge exactly once under concurrent verification", async () => {
    const { signedXdr } = validExchange();

    const results = await Promise.allSettled([
      verifyChallenge(signedXdr),
      verifyChallenge(signedXdr),
      verifyChallenge(signedXdr),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });

  it("does not consume a challenge that failed verification", async () => {
    const client = Keypair.random();
    const impostor = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());

    // A bad signature must not burn the pending challenge: the legitimate
    // wallet can still complete the same exchange afterwards.
    await expect(
      verifyChallenge(signAndEncode(impostor, transaction))
    ).rejects.toMatchObject(unauthorized);
    await expect(
      verifyChallenge(signAndEncode(client, transaction))
    ).resolves.toBe(client.publicKey());
  });

  // -- error hygiene ---------------------------------------------------------

  it("does not leak SDK error details in the rejection", async () => {
    await expect(verifyChallenge("garbage")).rejects.toMatchObject({
      status: 401,
      message: "Invalid or expired authentication challenge",
    });
  });
});
