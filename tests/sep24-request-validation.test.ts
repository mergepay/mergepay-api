/**
 * Tests for Issue #704: Request validation middleware for SEP-24 deposit
 * and withdrawal start endpoints.
 *
 * Verifies that dedicated Zod request validation middleware attached to
 * Fastify routes rejects invalid parameters with 400 Bad Request and structured
 * error payloads, and allows valid requests through to completion.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
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
import { config } from "../src/config";
import { signToken } from "../src/plugins/auth";
import { anchorService } from "../src/services/anchor";
import { validateSep24Deposit, validateSep24Withdraw } from "../src/schemas/sep24";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;
let userCounter = 0;

const authHeaders = () => ({
  authorization: `Bearer ${signToken({
    id: `user_${(userCounter += 1)}`,
    stellarPublicKey: Keypair.random().publicKey(),
  })}`,
  "content-type": "application/json",
});

describe("Issue #704: SEP-24 Request Validation Middleware", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    (anchorService.getToml as any).mockResolvedValue({
      webAuthEndpoint: "https://auth.example.com",
      transferServerSep24: "https://anchor.example.com/sep24",
      assets: [
        { code: "USDC", issuer: config.STABLE_ASSET_ISSUER },
        { code: "XLM", issuer: null },
      ],
    });
    (anchorService.getChallenge as any).mockResolvedValue({
      transaction: "AAAA...challengeXDR",
      network_passphrase: "Test SDF Network ; September 2015",
    });
    prisma.anchorSession.create.mockImplementation(async ({ data }: any) => ({
      id: "session_test_123",
      createdAt: new Date(),
      updatedAt: new Date(),
      ...data,
    }));
    app = await buildApp();
  });

  it("exports dedicated validateSep24Deposit and validateSep24Withdraw middleware functions", () => {
    expect(typeof validateSep24Deposit).toBe("function");
    expect(typeof validateSep24Withdraw).toBe("function");
  });

  describe("POST /api/sep24/deposit validation", () => {
    it("returns 400 Bad Request when assetCode is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          account: Keypair.random().publicKey(),
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.some((d: any) => d.field === "assetCode")).toBe(true);
    });

    it("returns 400 Bad Request when amount is negative or non-numeric", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          assetCode: "USDC",
          amount: "-10.5",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.some((d: any) => d.field === "amount")).toBe(true);
    });

    it("returns 400 Bad Request when Stellar account address has invalid format", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          assetCode: "USDC",
          account: "NOT_A_STELLAR_KEY",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.some((d: any) => d.field === "account")).toBe(true);
    });

    it("returns 400 Bad Request when memoType is invalid", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          assetCode: "USDC",
          memoType: "invalid_type",
          memo: "test",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.some((d: any) => d.field === "memoType")).toBe(true);
    });

    it("returns 400 Bad Request when memoType is 'id' but memo is not numeric", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          assetCode: "USDC",
          memoType: "id",
          memo: "not-a-number",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("returns 400 Bad Request when payload contains unknown properties (strict schema)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          assetCode: "USDC",
          unrecognizedKey: "evil",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("accepts valid deposit parameters and returns 200 with session and challenge", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/deposit",
        headers: authHeaders(),
        payload: {
          assetCode: "USDC",
          amount: "100.50",
          account: Keypair.random().publicKey(),
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.session).toBeDefined();
      expect(body.challenge).toBeDefined();
      expect(body.session.assetCode).toBe("USDC");
    });
  });

  describe("POST /api/sep24/withdraw validation", () => {
    it("returns 400 Bad Request when assetCode is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw",
        headers: authHeaders(),
        payload: {
          amount: "50",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.some((d: any) => d.field === "assetCode")).toBe(true);
    });

    it("returns 400 Bad Request when amount is zero or negative", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw",
        headers: authHeaders(),
        payload: {
          assetCode: "XLM",
          amount: "0",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
      expect(body.error.details.some((d: any) => d.field === "amount")).toBe(true);
    });

    it("returns 400 Bad Request when query string contains unexpected parameters", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw?unknownParam=xyz",
        headers: authHeaders(),
        payload: {
          assetCode: "XLM",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.payload);
      expect(body.error.code).toBe("VALIDATION_ERROR");
    });

    it("accepts valid withdrawal parameters and returns 200 with session and challenge", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sep24/withdraw",
        headers: authHeaders(),
        payload: {
          assetCode: "XLM",
          amount: "25.0000000",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.payload);
      expect(body.session).toBeDefined();
      expect(body.challenge).toBeDefined();
      expect(body.session.assetCode).toBe("XLM");
    });
  });
});
