/**
 * SEP-24 HTTP flows against the integration database, with only anchor I/O
 * mocked. This covers persisted initiation, database-backed status polling,
 * and failures at the route boundary without relying on an external anchor.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const anchor = vi.hoisted(() => ({
  getToml: vi.fn(),
  getChallenge: vi.fn(),
  getToken: vi.fn(),
  startInteractive: vi.fn(),
}));

vi.mock("../../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/anchor")>();
  return {
    ...actual,
    anchorService: { ...(actual as any).anchorService, ...anchor },
  };
});

import { buildApp } from "../../src/app";
import { prisma } from "../../src/db";
import { Errors } from "../../src/errors";
import { signToken } from "../../src/plugins/auth";

let app: Awaited<ReturnType<typeof buildApp>>;
let userId: string;
let publicKey: string;
let token: string;
let requestNumber = 0;

function remoteAddress(): string {
  requestNumber += 1;
  return `10.82.${Math.floor(requestNumber / 250)}.${(requestNumber % 250) + 1}`;
}

function post(url: string, payload: unknown, authenticated = true) {
  return app.inject({
    method: "POST",
    url,
    remoteAddress: remoteAddress(),
    headers: authenticated ? { authorization: `Bearer ${token}` } : {},
    payload,
  });
}

beforeAll(async () => {
  app = await buildApp();
  publicKey = Keypair.random().publicKey();
  const user = await prisma.user.create({
    data: { stellarPublicKey: publicKey, displayName: "SEP-24 flow integration" },
    select: { id: true },
  });
  userId = user.id;
  token = signToken({ id: userId, stellarPublicKey: publicKey });
});

beforeEach(() => {
  anchor.getToml.mockResolvedValue({
    webAuthEndpoint: "https://anchor.example.test/auth",
    transferServerSep24: "https://anchor.example.test/sep24",
    assets: [],
  });
  anchor.getChallenge.mockResolvedValue({
    transaction: "mock-challenge-xdr",
    networkPassphrase: "Integration Network",
  });
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("SEP-24 routes against PostgreSQL", () => {
  it("initiates and polls a deposit using its persisted session", async () => {
    const started = await post("/api/v1/sep24/deposit", { assetCode: "XLM" });

    expect(started.statusCode).toBe(200);
    expect(started.json().challenge).toMatchObject({
      transaction: "mock-challenge-xdr",
      networkPassphrase: "Integration Network",
    });
    const sessionId = started.json().session.id as string;
    const persisted = await prisma.anchorSession.findUnique({
      where: { id: sessionId },
    });
    expect(persisted).toMatchObject({ userId, kind: "deposit", assetCode: "XLM" });

    const poll = await app.inject({
      method: "GET",
      url: `/api/v1/sep24/transaction?id=${sessionId}`,
      remoteAddress: remoteAddress(),
      headers: { authorization: `Bearer ${token}` },
    });
    expect(poll.statusCode).toBe(200);
    expect(poll.json()).toMatchObject({ session_id: sessionId, kind: "deposit" });
    expect(anchor.getToml).toHaveBeenCalledTimes(1);
  });

  it("initiates a withdrawal and persists its direction", async () => {
    const started = await post("/api/v1/sep24/withdraw", {
      assetCode: "USDC",
      amount: "12.5",
    });

    expect(started.statusCode).toBe(200);
    const session = await prisma.anchorSession.findUnique({
      where: { id: started.json().session.id },
    });
    expect(session).toMatchObject({ userId, kind: "withdrawal", assetCode: "USDC" });
  });

  it("rejects unauthorized and unsupported-asset requests before creating a session", async () => {
    const unauthorized = await post(
      "/api/v1/sep24/deposit",
      { assetCode: "XLM" },
      false
    );
    expect(unauthorized.statusCode).toBe(401);

    const before = await prisma.anchorSession.count({ where: { userId } });
    const invalidAsset = await post("/api/v1/sep24/deposit", {
      assetCode: "NOTSUPPORTED",
    });
    expect(invalidAsset.statusCode).toBe(400);
    expect(await prisma.anchorSession.count({ where: { userId } })).toBe(before);
  });

  it("returns a stable upstream error when anchor initialization fails", async () => {
    anchor.getToml.mockRejectedValueOnce(Errors.upstream("Anchor unavailable"));

    const response = await post("/api/v1/sep24/deposit", { assetCode: "XLM" });

    expect(response.statusCode).toBe(502);
    expect(response.json().code).toBe("UPSTREAM_ERROR");
  });
});