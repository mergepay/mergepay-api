import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, Transaction, WebAuth, Networks } from "@stellar/stellar-sdk";

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

import { buildChallenge, verifyChallenge, serverKeypair } from "../src/services/sep10";
import { config } from "../src/config";

function signAndEncode(client: Keypair, transaction: string): string {
  const tx = new Transaction(transaction, config.networkPassphrase);
  tx.sign(client);
  return tx.toXDR();
}

describe("SEP-10 hardening", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects a malformed challenge string", async () => {
    await expect(verifyChallenge("not-a-real-xdr")).rejects.toMatchObject({
      status: 401,
    });
  });

  it("rejects an expired challenge", async () => {
    // The SDK grants a 5-minute clock-skew grace period past a challenge's
    // own timeout, so jump the clock forward instead of waiting for real
    // time to pass.
    vi.useFakeTimers();
    try {
      const client = Keypair.random();
      const { transaction } = buildChallenge(client.publicKey());
      const signedXdr = signAndEncode(client, transaction);

      vi.advanceTimersByTime((300 + 301) * 1000);

      await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({ status: 401 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a challenge built on the wrong network", async () => {
    const client = Keypair.random();
    const wrongNetwork =
      config.networkPassphrase === Networks.TESTNET ? Networks.PUBLIC : Networks.TESTNET;
    const transaction = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      config.SEP10_HOME_DOMAIN,
      300,
      wrongNetwork,
      config.WEB_AUTH_DOMAIN
    );
    const tx = new Transaction(transaction, wrongNetwork);
    tx.sign(client);

    await expect(verifyChallenge(tx.toXDR())).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a challenge built for the wrong home domain", async () => {
    const client = Keypair.random();
    const transaction = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      "not-the-configured-domain.example",
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const signedXdr = signAndEncode(client, transaction);

    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a challenge signed by the wrong account", async () => {
    const client = Keypair.random();
    const impostor = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const signedXdr = signAndEncode(impostor, transaction);

    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({ status: 401 });
  });

  it("rejects replay of an already-consumed signed challenge", async () => {
    const client = Keypair.random();
    const { transaction } = buildChallenge(client.publicKey());
    const signedXdr = signAndEncode(client, transaction);

    const first = await verifyChallenge(signedXdr);
    expect(first).toBe(client.publicKey());

    await expect(verifyChallenge(signedXdr)).rejects.toMatchObject({ status: 401 });
  });

  it("does not leak SDK error details in the rejection", async () => {
    try {
      await verifyChallenge("garbage");
      throw new Error("expected verifyChallenge to reject");
    } catch (e: any) {
      expect(e.message).not.toMatch(/xdr|base64|manage_data|invalid/i);
    }
  });
});
