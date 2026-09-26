import { describe, it, expect, beforeAll, vi } from "vitest";
import Fastify from "fastify";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    create: vi.fn(),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    accountBalance: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $queryRaw: vi.fn(async () => [{ "column?": 1 }]),
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

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: vi.fn(),
      })),
    },
  };
});

import { signToken } from "../src/plugins/auth";
import authPlugin from "../src/plugins/auth";
import errorHandlerPlugin from "../src/plugins/error-handler";
import accountRoutes from "../src/routes/accounts";

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({
    id: user.id,
    stellarPublicKey: user.stellarPublicKey,
  });
  return { authorization: `Bearer ${token}` };
}

let app: ReturnType<typeof Fastify>;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(authPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(accountRoutes);
  await app.ready();
});

describe("accounts routes", () => {
  it("GET /accounts/:id/balances returns balances for a valid id", async () => {
    h.prisma.group.findFirst.mockResolvedValueOnce({
      id: "group_1",
      treasuryAccountPublicKey: "GABCDEF",
    });
    h.prisma.accountBalance.findMany.mockResolvedValueOnce([
      {
        assetCode: "XLM",
        balance: "100.0000000",
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/accounts/group_1/balances",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().balances).toHaveLength(1);
    expect(res.json().balances[0].assetCode).toBe("XLM");
  });

  it("GET /accounts/:id/balances returns 400 for an empty id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/accounts//balances",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.requestId).toBeTruthy();
  });
});
