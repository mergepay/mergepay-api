/**
 * SEP-10 strict challenge validation (#550).
 *
 * Challenges here are assembled by hand with the SDK's TransactionBuilder and
 * signed by *both* the real server key and the client, so each rejection is
 * attributable to the one rule a case breaks — never to a missing signature.
 * A baseline case proves the hand-built challenge is otherwise accepted.
 *
 * Horizon is mocked per case (unfunded vs. funded multisig account); the
 * database is absent, so replay protection uses its documented in-process
 * test path. Time is controlled with fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  Account,
  BASE_FEE,
  Keypair,
  Memo,
  MuxedAccount,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
  WebAuth,
  xdr,
} from "@stellar/stellar-sdk";

vi.mock("../src/db", () => ({ prisma: {} }));

const h = vi.hoisted(() => ({ loadAccount: vi.fn() }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return { ...actual, stellar: { ...actual.stellar, loadAccount: h.loadAccount } };
});

import {
  authenticateChallenge,
  buildChallenge,
  serverKeypair,
  verifyChallenge,
} from "../src/services/sep10";
import { config } from "../src/config";

const T0 = new Date("2026-09-26T14:00:00.000Z");
const nowS = () => Math.floor(Date.now() / 1000);

const UNFUNDED = {
  exists: false,
  sequence: "0",
  balances: [],
  signers: [],
  thresholds: { low: 0, med: 0, high: 0 },
};

interface ChallengeOptions {
  client: Keypair;
  /** Op source for the auth operation; defaults to the client's G address. */
  clientAccountId?: string;
  source?: Keypair;
  sequence?: string;
  homeDomain?: string;
  timebounds?: { minTime: number; maxTime: number };
  networkPassphrase?: string;
  memo?: Memo;
  /** Operations after the auth op; defaults to one correct `web_auth_domain`. */
  extraOps?: xdr.Operation[];
  /** Keys that sign the envelope; defaults to [server, client]. */
  signers?: Keypair[];
}

function webAuthDomainOp(value = config.WEB_AUTH_DOMAIN, source = serverKeypair().publicKey()) {
  return Operation.manageData({ name: "web_auth_domain", value, source });
}

/** Hand-assemble a SEP-10 challenge, identical to the SDK's unless overridden. */
function challenge(opts: ChallengeOptions): Transaction {
  const server = serverKeypair();
  const source = opts.source ?? server;
  const passphrase = opts.networkPassphrase ?? config.networkPassphrase;
  const now = nowS();

  const builder = new TransactionBuilder(
    // Sequence "-1" makes the built transaction's sequence 0.
    new Account(source.publicKey(), opts.sequence ?? "-1"),
    {
      fee: BASE_FEE,
      networkPassphrase: passphrase,
      timebounds: opts.timebounds ?? { minTime: now, maxTime: now + 300 },
    }
  ).addOperation(
    Operation.manageData({
      name: `${opts.homeDomain ?? config.SEP10_HOME_DOMAIN} auth`,
      value: randomBytes(48).toString("base64"),
      source: opts.clientAccountId ?? opts.client.publicKey(),
    })
  );
  for (const op of opts.extraOps ?? [webAuthDomainOp()]) builder.addOperation(op);
  if (opts.memo) builder.addMemo(opts.memo);

  const tx = builder.build();
  for (const signer of opts.signers ?? [server, opts.client]) tx.sign(signer);
  return tx;
}

const xdrOf = (tx: Transaction) => tx.toXDR();
const UNAUTHORIZED = { status: 401, code: "UNAUTHORIZED" };
const SIGNATURE_MESSAGE = /signature verification failed/i;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  h.loadAccount.mockReset().mockResolvedValue(UNFUNDED);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Baseline ────────────────────────────────────────────────────────────────

describe("baseline", () => {
  it("accepts the hand-built challenge, so every variant below fails for its one change", async () => {
    const client = Keypair.random();
    await expect(verifyChallenge(xdrOf(challenge({ client })))).resolves.toBe(client.publicKey());
  });

  it("returns the challenge transaction hash for the session jti", async () => {
    const client = Keypair.random();
    const tx = challenge({ client });

    await expect(authenticateChallenge(xdrOf(tx))).resolves.toEqual({
      account: client.publicKey(),
      challengeHash: tx.hash().toString("hex"),
    });
  });

  it("builds challenges with sequence 0, the server source, and a bounded 300s window", () => {
    const client = Keypair.random();
    const tx = new Transaction(buildChallenge(client.publicKey()).transaction, config.networkPassphrase);

    expect(tx.sequence).toBe("0");
    expect(tx.source).toBe(serverKeypair().publicKey());
    expect(Number(tx.timeBounds?.minTime)).toBe(nowS());
    expect(Number(tx.timeBounds?.maxTime)).toBe(nowS() + 300);
    expect(tx.memo.type).toBe("none");
    expect(tx.operations.map((op) => [op.type, op.source])).toEqual([
      ["manageData", client.publicKey()],
      ["manageData", serverKeypair().publicKey()],
    ]);
    expect(WebAuth.verifyTxSignedBy(tx, serverKeypair().publicKey())).toBe(true);
  });
});

// ─── Structure ───────────────────────────────────────────────────────────────

describe("structure and domains", () => {
  const client = Keypair.random();
  const other = Keypair.random();

  it.each<[string, () => ChallengeOptions]>([
    ["a non-zero sequence number", () => ({ client, sequence: "41" })],
    ["a source other than the server account", () => ({ client, source: other, signers: [Keypair.random(), other, client] })],
    ["a mismatched home domain", () => ({ client, homeDomain: "evil.example.com" })],
    ["a mismatched web_auth_domain", () => ({ client, extraOps: [webAuthDomainOp("evil.example.com")] })],
    ["a missing web_auth_domain operation", () => ({ client, extraOps: [] })],
    ["a duplicated web_auth_domain operation", () => ({ client, extraOps: [webAuthDomainOp(), webAuthDomainOp()] })],
    ["an extra operation sourced by the client", () => ({
      client,
      extraOps: [webAuthDomainOp(), Operation.manageData({ name: "extra", value: "x", source: client.publicKey() })],
    })],
    ["an extra server-sourced operation that is not web_auth_domain", () => ({
      client,
      extraOps: [webAuthDomainOp(), Operation.manageData({ name: "extra", value: "x", source: serverKeypair().publicKey() })],
    })],
    ["a client_domain operation (not supported)", () => {
      const clientDomainKey = Keypair.random();
      return {
        client,
        extraOps: [
          webAuthDomainOp(),
          Operation.manageData({ name: "client_domain", value: "wallet.example.com", source: clientDomainKey.publicKey() }),
        ],
        signers: [serverKeypair(), client, clientDomainKey],
      };
    }],
    ["an id memo (not supported)", () => ({ client, memo: Memo.id("42") })],
    ["a muxed (M...) client account (not supported)", () => ({
      client,
      clientAccountId: new MuxedAccount(new Account(client.publicKey(), "0"), "42").accountId(),
    })],
    ["infinite timebounds (maxTime 0)", () => ({ client, timebounds: { minTime: 0, maxTime: 0 } })],
  ])("rejects %s with the generic 401", async (_label, options) => {
    await expect(verifyChallenge(xdrOf(challenge(options())))).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("rejects a challenge signed for the wrong network passphrase", async () => {
    const wrong = config.networkPassphrase === Networks.TESTNET ? Networks.PUBLIC : Networks.TESTNET;
    const tx = challenge({ client, networkPassphrase: wrong });
    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("rejects a challenge with no timebounds at all", async () => {
    const tx = challenge({ client, signers: [] });
    const envelope = tx.toEnvelope();
    envelope.v1().tx().cond(xdr.Preconditions.precondNone());
    const unbounded = new Transaction(envelope, config.networkPassphrase);
    expect(unbounded.timeBounds).toBeUndefined();
    unbounded.sign(serverKeypair());
    unbounded.sign(client);

    await expect(verifyChallenge(unbounded.toXDR())).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("rejects a fee-bump envelope wrapping an otherwise valid challenge", async () => {
    const inner = challenge({ client });
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      serverKeypair(),
      String(Number(BASE_FEE) * 10),
      inner,
      config.networkPassphrase
    );
    feeBump.sign(serverKeypair());

    await expect(verifyChallenge(feeBump.toXDR())).rejects.toMatchObject(UNAUTHORIZED);
  });

  it.each(["not base64 at all!", "AAAA", ""])("rejects malformed XDR %j", async (bad) => {
    await expect(verifyChallenge(bad)).rejects.toMatchObject(UNAUTHORIZED);
  });
});

// ─── Timebounds ──────────────────────────────────────────────────────────────

describe("timebounds", () => {
  it("rejects an expired server-issued challenge with CHALLENGE_EXPIRED", async () => {
    const client = Keypair.random();
    const signed = xdrOf(challenge({ client }));
    vi.setSystemTime(new Date(T0.getTime() + 331_000)); // past maxTime + 30s skew

    await expect(verifyChallenge(signed)).rejects.toMatchObject({ status: 401, code: "CHALLENGE_EXPIRED" });
  });

  it("reports an expired envelope the server never signed as the generic 401, not CHALLENGE_EXPIRED", async () => {
    // Expired beyond the SDK's own 300s grace, so the SDK's expiry check fires
    // before it ever looks at the server signature.
    const client = Keypair.random();
    const forger = Keypair.random();
    const signed = xdrOf(challenge({ client, signers: [forger, client] }));
    vi.setSystemTime(new Date(T0.getTime() + 700_000));

    await expect(verifyChallenge(signed)).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("reports a challenge that is not valid yet as the generic 401, not CHALLENGE_EXPIRED", async () => {
    const client = Keypair.random();
    const start = nowS() + 600; // beyond the SDK's 300s grace
    const tx = challenge({ client, timebounds: { minTime: start, maxTime: start + 300 } });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("rejects a challenge that starts beyond the 30s clock-skew tolerance", async () => {
    const client = Keypair.random();
    const start = nowS() + 120; // inside the SDK's grace, outside ours
    const tx = challenge({ client, timebounds: { minTime: start, maxTime: start + 300 } });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("rejects a window longer than the validity this server issues", async () => {
    const client = Keypair.random();
    const tx = challenge({ client, timebounds: { minTime: nowS(), maxTime: nowS() + 3600 } });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("accepts a challenge inside the skew tolerance after maxTime", async () => {
    const client = Keypair.random();
    const signed = xdrOf(challenge({ client }));
    vi.setSystemTime(new Date(T0.getTime() + 320_000));

    await expect(verifyChallenge(signed)).resolves.toBe(client.publicKey());
  });
});

// ─── Signatures ──────────────────────────────────────────────────────────────

describe("signatures — unfunded account (master key)", () => {
  it("rejects a challenge missing the server signature", async () => {
    const client = Keypair.random();
    const tx = challenge({ client, signers: [client] });
    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("rejects a challenge signed by a different key instead of the client", async () => {
    const client = Keypair.random();
    const tx = challenge({ client, signers: [serverKeypair(), Keypair.random()] });
    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401, message: expect.stringMatching(SIGNATURE_MESSAGE) });
  });

  it("rejects an extra unrecognized signature", async () => {
    const client = Keypair.random();
    const tx = challenge({ client, signers: [serverKeypair(), client, Keypair.random()] });
    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401, message: expect.stringMatching(SIGNATURE_MESSAGE) });
  });

  it("rejects a duplicated client signature", async () => {
    const client = Keypair.random();
    const tx = challenge({ client, signers: [serverKeypair(), client, client] });
    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401, message: expect.stringMatching(SIGNATURE_MESSAGE) });
  });

  it("fails closed when Horizon cannot be reached", async () => {
    h.loadAccount.mockRejectedValueOnce(new Error("horizon down"));
    const client = Keypair.random();
    await expect(verifyChallenge(xdrOf(challenge({ client })))).rejects.toMatchObject(UNAUTHORIZED);
  });
});

describe("signatures — funded account (signers and medium threshold)", () => {
  const master = Keypair.random();
  const cosignerA = Keypair.random();
  const cosignerB = Keypair.random();

  function funded(med: number, signers: { key: string; weight: number }[]) {
    return { ...UNFUNDED, exists: true, sequence: "100", signers, thresholds: { low: 1, med, high: 3 } };
  }

  // Master key disabled (weight 0), two cosigners of weight 1, medium threshold 2,
  // plus a hash-x signer Horizon reports but no signature can match.
  const multisig = funded(2, [
    { key: master.publicKey(), weight: 0 },
    { key: cosignerA.publicKey(), weight: 1 },
    { key: cosignerB.publicKey(), weight: 1 },
    { key: "XDRPF6NZRR7EEVO7ESIWUDXHAOMM2QSKIQQBJK6I2FB7YKDZES5UCLWD", weight: 1 },
  ]);

  it("accepts signatures whose combined weight meets the medium threshold", async () => {
    h.loadAccount.mockResolvedValue(multisig);
    const tx = challenge({ client: master, signers: [serverKeypair(), cosignerA, cosignerB] });

    await expect(verifyChallenge(xdrOf(tx))).resolves.toBe(master.publicKey());
  });

  it("rejects signatures below the medium threshold", async () => {
    h.loadAccount.mockResolvedValue(multisig);
    const tx = challenge({ client: master, signers: [serverKeypair(), cosignerA] });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401, message: expect.stringMatching(SIGNATURE_MESSAGE) });
  });

  it("gives a disabled (weight 0) master key no weight", async () => {
    h.loadAccount.mockResolvedValue(multisig);
    const tx = challenge({ client: master, signers: [serverKeypair(), master, cosignerA] });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401 });
  });

  it("rejects a signature from a key that is not one of the account's signers", async () => {
    h.loadAccount.mockResolvedValue(multisig);
    const tx = challenge({ client: master, signers: [serverKeypair(), cosignerA, cosignerB, Keypair.random()] });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401, message: expect.stringMatching(SIGNATURE_MESSAGE) });
  });

  it("never counts the server's signature toward the threshold", async () => {
    // Even if the account lists the server key as a heavy signer.
    h.loadAccount.mockResolvedValue(
      funded(1, [{ key: master.publicKey(), weight: 1 }, { key: serverKeypair().publicKey(), weight: 10 }])
    );
    const tx = challenge({ client: master, signers: [serverKeypair()] });

    await expect(verifyChallenge(xdrOf(tx))).rejects.toMatchObject({ status: 401 });
  });

  it("still requires a real signature when the medium threshold is 0", async () => {
    h.loadAccount.mockResolvedValue(funded(0, [{ key: master.publicKey(), weight: 1 }]));
    const unsigned = challenge({ client: master, signers: [serverKeypair()] });
    await expect(verifyChallenge(xdrOf(unsigned))).rejects.toMatchObject({ status: 401 });

    const signed = challenge({ client: master });
    await expect(verifyChallenge(xdrOf(signed))).resolves.toBe(master.publicKey());
  });
});

// ─── Replay ──────────────────────────────────────────────────────────────────

describe("replay protection", () => {
  it("rejects a second redemption of the same challenge", async () => {
    const client = Keypair.random();
    const signed = xdrOf(challenge({ client }));

    await expect(verifyChallenge(signed)).resolves.toBe(client.publicKey());
    await expect(verifyChallenge(signed)).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("keeps the redemption record until the challenge can no longer be accepted", async () => {
    // Redeemed 5s in; the challenge stays acceptable until maxTime + 30s skew
    // (T0+330s). A record that expired at "redeemed + 300s" (T0+305s) would be
    // swept at T0+310s and the same envelope accepted again.
    const client = Keypair.random();
    const signed = xdrOf(challenge({ client }));

    vi.setSystemTime(new Date(T0.getTime() + 5_000));
    await expect(verifyChallenge(signed)).resolves.toBe(client.publicKey());

    vi.setSystemTime(new Date(T0.getTime() + 310_000));
    // Trigger the in-process sweep with an unrelated redemption first.
    const other = Keypair.random();
    await expect(verifyChallenge(xdrOf(challenge({ client: other })))).resolves.toBe(other.publicKey());

    await expect(verifyChallenge(signed)).rejects.toMatchObject(UNAUTHORIZED);
  });

  it("does not burn a challenge that failed signature verification", async () => {
    const client = Keypair.random();
    const base = challenge({ client, signers: [serverKeypair()] });
    const wrong = new Transaction(base.toXDR(), config.networkPassphrase);
    wrong.sign(Keypair.random());
    await expect(verifyChallenge(wrong.toXDR())).rejects.toMatchObject({ status: 401 });

    const right = new Transaction(base.toXDR(), config.networkPassphrase);
    right.sign(client);
    await expect(verifyChallenge(right.toXDR())).resolves.toBe(client.publicKey());
  });
});
