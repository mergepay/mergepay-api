import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair, Transaction } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    anchorSession: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

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

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { buildChallenge } from "../src/services/sep10";

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

describe("auth routes", () => {
  it("GET /health is open", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("POST /auth/challenge returns a transaction + passphrase", async () => {
    const client = Keypair.random();
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: client.publicKey() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction).toBeTruthy();
    expect(body.networkPassphrase).toBeTruthy();
  });

  it("POST /auth/challenge rejects an invalid account", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: "not-a-key" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("INVALID_ACCOUNT");
    expect(body.message).toBe("Not a valid Stellar public key");
    expect(body.statusCode).toBe(400);
    expect(body.requestId).toBeDefined();
  });

  it("POST /auth/verify issues a JWT for a signed challenge", async () => {
    const client = Keypair.random();
    const user = fakeUser({ stellarPublicKey: client.publicKey() });
    prisma.user.upsert.mockResolvedValueOnce(user);
    prisma.auditLog.create.mockResolvedValueOnce({});

    const { transaction, networkPassphrase } = buildChallenge(client.publicKey());
    const tx = new Transaction(transaction, networkPassphrase);
    tx.sign(client);

    const res = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { transaction: tx.toXDR() },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.token).toBeTruthy();
    expect(body.user.stellarPublicKey).toBe(client.publicKey());
  });

  it("GET /me requires a token", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBe("UNAUTHORIZED");
    expect(body.statusCode).toBe(401);
    expect(body.requestId).toBeDefined();
  });
});

describe("error handler", () => {
  it("returns standard format for unknown routes", async () => {
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error).toBe("NOT_FOUND");
    expect(body.statusCode).toBe(404);
    expect(body.requestId).toBeDefined();
  });

  it("returns standard format for Zod validation errors", async () => {
    const client = Keypair.random();
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: 123 },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
    expect(body.details).toBeDefined();
    expect(body.requestId).toBeDefined();
  });

  it("does not leak stack traces in production", async () => {
    // This is a basic structure check; actual env testing would need more setup
    const res = await app.inject({ method: "GET", url: "/does-not-exist" });
    const body = res.json();
    expect(body.stack).toBeUndefined();
  });
});
