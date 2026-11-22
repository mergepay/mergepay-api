import { describe, it, expect, beforeEach, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({ id: "row_1" })),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 0 })),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    invite: model(),
    invitation: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    anchorSession: model(),
    withdrawal: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
    refreshToken: model(),
    rateLimitBucket: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/anchor", () => ({
  anchorService: {
    getToml: vi.fn(),
    getChallenge: vi.fn(),
    getToken: vi.fn(),
    startInteractive: vi.fn(),
  },
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { rateLimited, rateLimitPolicies } from "../src/lib/rate-limit";

const prisma = h.prisma;

let app: Awaited<ReturnType<typeof buildApp>>;

function authHeaders() {
  return {
    authorization: `Bearer ${signToken({
      id: `user_${Keypair.random().publicKey().slice(0, 12)}`,
      stellarPublicKey: Keypair.random().publicKey(),
    })}`,
    "content-type": "application/json",
  };
}

function expectValidationEnvelope(res: { statusCode: number; json: () => any }) {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.error.details.length).toBeGreaterThan(0);
  expect(body.error.issues.length).toBeGreaterThan(0);
  return body;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp({ rateLimit: "off" });
});

describe("SEP-24 hardening (#1026) input validation", () => {
  it("rejects an invalid asset code before any database or anchor work", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeaders(),
      payload: {
        assetCode: "NOT_A_VALID_ASSET_CODE",
        account: Keypair.random().publicKey(),
      },
    });

    expectValidationEnvelope(res);
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid Stellar account before any database or anchor work", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeaders(),
      payload: { assetCode: "USDC", account: "NOT_A_STELLAR_KEY" },
    });

    expectValidationEnvelope(res);
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized amount before any database or anchor work", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/withdraw",
      headers: authHeaders(),
      payload: {
        assetCode: "USDC",
        amount: "9999999999999999999999999999.0",
        account: Keypair.random().publicKey(),
      },
    });

    expectValidationEnvelope(res);
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed transaction id before querying the database", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/sep24/transaction?id=not%20an%20id",
      headers: authHeaders(),
    });

    expectValidationEnvelope(res);
    expect(prisma.anchorSession.findFirst).not.toHaveBeenCalled();
  });

  it("answers absent and foreign transaction ids with the same 404 envelope", async () => {
    const absent = await app.inject({
      method: "GET",
      url: "/api/sep24/transaction?id=missing_tx",
      headers: authHeaders(),
    });
    const foreign = await app.inject({
      method: "GET",
      url: "/api/sep24/transaction?id=foreign_tx",
      headers: authHeaders(),
    });

    for (const res of [absent, foreign]) {
      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error.code).toBe("NOT_FOUND");
      expect(body.code).toBe("NOT_FOUND");
      expect(body.message).toBe("Transaction not found");
      expect(body.requestId).toBeTruthy();
    }
  });
});

describe("SEP-24 hardening (#1026) rate limits", () => {
  it("keeps every SEP-24 policy below the global budget", () => {
    const policies = rateLimitPolicies();
    for (const name of ["anchorInit", "anchorPoll", "anchorWebhook", "sep24Callback", "sep24Webhook"] as const) {
      expect(policies[name].max).toBeLessThan(policies.global.max);
    }
  });

  it("returns 429 once the SEP-24 callback route budget is spent", async () => {
    const policy = rateLimitPolicies().sep24Callback;
    const handler = vi.fn(async () => ({ ok: true }));
    const limitedApp = Fastify({ logger: false });
    await limitedApp.register(rateLimit, {
      global: true,
      max: 1000,
      timeWindow: 60_000,
      keyGenerator: (request) => `global:ip:${request.ip}`,
    });
    limitedApp.post(
      "/sep24/callback",
      rateLimited("sep24Callback") as never,
      handler
    );
    await limitedApp.ready();

    let first: Awaited<ReturnType<typeof limitedApp.inject>> | undefined;
    for (let i = 0; i < policy.max; i += 1) {
      const res = await limitedApp.inject({ method: "POST", url: "/sep24/callback" });
      expect(res.statusCode).toBe(200);
      first ??= res;
    }
    const blocked = await limitedApp.inject({ method: "POST", url: "/sep24/callback" });

    expect(first).toBeDefined();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["x-ratelimit-limit"]).toBe(String(policy.max));
    expect(handler).toHaveBeenCalledTimes(policy.max);
    await limitedApp.close();
  });
});
