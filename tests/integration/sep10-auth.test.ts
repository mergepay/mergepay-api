import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair, MemoNone, Transaction, WebAuth } from "@stellar/stellar-sdk";

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { upsert: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../../src/db", () => ({ prisma: mocks.prisma }));

vi.mock("../../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/stellar")>();
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

vi.mock("../../src/services/refresh-token", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/refresh-token")>();
  return {
    ...actual,
    issueRefreshToken: vi.fn(async () => ({
      token: "integration-refresh-token",
      expiresAt: new Date("2026-12-31T00:00:00.000Z"),
    })),
  };
});

import { buildApp } from "../../src/app";
import { config } from "../../src/config";
import { verifyToken } from "../../src/plugins/auth";
import { serverKeypair } from "../../src/services/sep10";

const user = {
  id: "sep10_integration_user",
  displayName: "SEP-10 Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

let app: Awaited<ReturnType<typeof buildApp>>;
let requestNumber = 0;

function remoteAddress(): string {
  requestNumber += 1;
  return `10.70.${Math.floor(requestNumber / 250)}.${(requestNumber % 250) + 1}`;
}

async function requestChallenge(account: string) {
  return app.inject({
    method: "POST",
    url: "/auth/challenge",
    remoteAddress: remoteAddress(),
    payload: { account },
  });
}

async function verifyEnvelope(transaction: string) {
  return app.inject({
    method: "POST",
    url: "/auth/verify",
    remoteAddress: remoteAddress(),
    payload: { transaction },
  });
}

function signChallenge(transaction: string, signer: Keypair): string {
  const signed = new Transaction(transaction, config.networkPassphrase);
  signed.sign(signer);
  return signed.toXDR();
}

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.user.upsert.mockImplementation(async ({ where }) => ({
    ...user,
    stellarPublicKey: where.stellarPublicKey,
  }));
});

afterAll(async () => {
  await app.close();
});

describe("SEP-10 authentication integration", () => {
  it("returns a server-signed challenge with the configured domains and XDR structure", async () => {
    const client = Keypair.random();
    const response = await requestChallenge(client.publicKey());

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.networkPassphrase).toBe(config.networkPassphrase);
    expect(typeof body.transaction).toBe("string");

    const transaction = new Transaction(body.transaction, config.networkPassphrase);
    const server = serverKeypair();
    expect(transaction.source).toBe(server.publicKey());
    expect(String(transaction.sequence)).toBe("0");
    expect(transaction.memo.type).toBe(MemoNone);
    expect(WebAuth.verifyTxSignedBy(transaction, server.publicKey())).toBe(true);

    const bounds = transaction.timeBounds;
    expect(bounds).not.toBeNull();
    expect(Number(bounds!.maxTime)).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(Number(bounds!.maxTime) - Number(bounds!.minTime)).toBeLessThanOrEqual(
      300
    );

    const operations = transaction.operations;
    expect(operations).toHaveLength(2);
    expect(operations[0]).toMatchObject({
      type: "manageData",
      source: client.publicKey(),
      name: `${config.SEP10_HOME_DOMAIN} auth`,
    });
    expect(Buffer.from(operations[0].value!).length).toBeGreaterThanOrEqual(32);
    expect(operations[1]).toMatchObject({
      type: "manageData",
      source: server.publicKey(),
      name: "web_auth_domain",
    });
    expect(Buffer.from(operations[1].value!).toString("utf8")).toBe(
      config.WEB_AUTH_DOMAIN
    );
  });

  it("verifies the client's signature and issues a JWT for the authenticated account", async () => {
    const client = Keypair.random();
    const challenge = await requestChallenge(client.publicKey());
    const transaction = challenge.json().transaction as string;
    const signedXdr = signChallenge(transaction, client);

    const response = await verifyEnvelope(signedXdr);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.refreshToken).toBe("integration-refresh-token");
    expect(body.user.stellarPublicKey).toBe(client.publicKey());
    expect(verifyToken(body.token)).toEqual({
      id: "sep10_integration_user",
      stellarPublicKey: client.publicKey(),
    });
    expect(mocks.prisma.user.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { stellarPublicKey: client.publicKey() },
      })
    );
  });

  it("rejects a challenge signed by a different client key without issuing a token", async () => {
    const client = Keypair.random();
    const attacker = Keypair.random();
    const challenge = await requestChallenge(client.publicKey());
    const signedXdr = signChallenge(challenge.json().transaction, attacker);

    const response = await verifyEnvelope(signedXdr);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("UNAUTHORIZED");
    expect(mocks.prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("rejects a correctly signed challenge for a different home domain", async () => {
    const client = Keypair.random();
    const transaction = WebAuth.buildChallengeTx(
      serverKeypair(),
      client.publicKey(),
      "other-anchor.example.com",
      300,
      config.networkPassphrase,
      config.WEB_AUTH_DOMAIN
    );
    const signedXdr = signChallenge(transaction, client);

    const response = await verifyEnvelope(signedXdr);

    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe("UNAUTHORIZED");
    expect(mocks.prisma.user.upsert).not.toHaveBeenCalled();
  });

  it("allows each signed challenge to be redeemed only once", async () => {
    const client = Keypair.random();
    const challenge = await requestChallenge(client.publicKey());
    const signedXdr = signChallenge(challenge.json().transaction, client);

    const first = await verifyEnvelope(signedXdr);
    const replay = await verifyEnvelope(signedXdr);

    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json().code).toBe("UNAUTHORIZED");
    expect(mocks.prisma.user.upsert).toHaveBeenCalledTimes(1);
  });
});
