import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { FastifyInstance } from "fastify";

function createMockPrisma(): PrismaClient {
  const users = new Map<string, any>();
  users.set("user_1", { id: "user_1", stellarPublicKey: "GUSER1", displayName: "U1" });
  users.set("user_2", { id: "user_2", stellarPublicKey: "GUSER2", displayName: "U2" });

  const group = {
    id: "group_1",
    name: "T",
    description: null,
    createdByUserId: "user_creator",
    treasuryEnabled: true,
    treasuryAccountPublicKey: "GTREASURY",
    treasuryRequiredSigners: 1,
    archived: false,
    createdAt: new Date(),
  };

  const treasuryTxs = new Map<string, any>();

  return {
    user: {
      findUnique: async ({ where }: any) => users.get(where.id ?? where.stellarPublicKey),
    },
    group: {
      findUnique: async ({ where }: any) => (where.id ? group : undefined),
      update: async ({ where, data }: any) => {
        if (where.id !== group.id) throw new Error("group missing");
        Object.assign(group, data);
        return group;
      },
    },
    treasuryTransaction: {
      create: async ({ data }: any) => {
        const tx = {
          id: `ttx_${Math.random().toString(36).slice(2)}`,
          ...data,
          status: data.status ?? "pending",
          createdAt: new Date(),
        };
        treasuryTxs.set(tx.id, tx);
        return tx;
      },
      findUnique: async ({ where }: any) => treasuryTxs.get(where.id),
      update: async ({ where, data }: any) => {
        const existing = treasuryTxs.get(where.id);
        if (!existing) throw new Error("tx missing");
        const updated = { ...existing, ...data };
        treasuryTxs.set(where.id, updated);
        return updated;
      },
      updateMany: async ({ where, data }: any) => {
        const target = treasuryTxs.get(where.id);
        if (!target || target.status !== "pending") return { count: 0 };
        Object.assign(target, data);
        return { count: 1 };
      },
    },
  } as unknown as PrismaClient;
}

describe("treasury idempotency integration", () => {
  let app: FastifyInstance;
  let prisma: PrismaClient;

  async function buildApp() {
    const mod = await import("../src/app");
    return (await mod.buildApp()) as any;
  }

  beforeEach(async () => {
    prisma = createMockPrisma();
    vi.resetModules();
    vi.doMock("../src/db", () => ({ prisma }));
    app = await buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  async function authHeader(userId = "user_1") {
    const payload = { id: userId, stellarPublicKey: `G${userId.toUpperCase()}` };
    const token = Buffer.from(JSON.stringify(payload)).toString("base64");
    return { authorization: `Bearer ${token}` };
  }

  it("replays same treasury.deposit request when key and params match", async () => {
    const headers = { ...(await authHeader()), "idempotency-key": "dep-1" };
    const body = { amount: "10", assetCode: "USDC", assetIssuer: null };

    const r1 = await app.inject({ method: "POST", url: `/groups/group_1/treasury/deposit`, headers, body: JSON.stringify(body) });
    const r2 = await app.inject({ method: "POST", url: `/groups/group_1/treasury/deposit`, headers, body: JSON.stringify(body) });

    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    const j1 = r1.json() as any;
    const j2 = r2.json() as any;
    expect(j1.treasuryTransaction.shortCode).toBe(j2.treasuryTransaction.shortCode);
    expect(j1.treasuryTransaction.xdr).toBe(j2.treasuryTransaction.xdr);
  });

  it("rejects treasury.withdraw with same key but different params", async () => {
    const headers = { ...(await authHeader()), "idempotency-key": "wd-1" };
    const body1 = { amount: "10", assetCode: "USDC", assetIssuer: null, destination: "GDEST1" };
    const r1 = await app.inject({ method: "POST", url: `/groups/group_1/treasury/withdraw`, headers, body: JSON.stringify(body1) });
    expect(r1.statusCode).toBe(200);

    const body2 = { amount: "20", assetCode: "USDC", assetIssuer: null, destination: "GDEST2" };
    const r2 = await app.inject({ method: "POST", url: `/groups/group_1/treasury/withdraw`, headers, body: JSON.stringify(body2) });
    expect(r2.statusCode).toBe(409);
  });

  it("separates keys by authenticated user", async () => {
    const headersA = { ...(await authHeader()), "idempotency-key": "cross-user" };
    const headersB = {
      authorization: `Bearer ${Buffer.from(JSON.stringify({ id: "user_2", stellarPublicKey: "GUSER2" })).toString("base64")}`,
      "idempotency-key": "cross-user",
    };
    const body = { amount: "5", assetCode: "USDC", assetIssuer: null };

    const r1 = await app.inject({ method: "POST", url: `/groups/group_1/treasury/deposit`, headers: headersA, body: JSON.stringify(body) });
    const r2 = await app.inject({ method: "POST", url: `/groups/group_1/treasury/deposit`, headers: headersB, body: JSON.stringify(body) });
    expect([r1.statusCode, r2.statusCode]).toEqual([200, 200]);

    const creators = Array.from(treasuryTxs.values()).map((t: any) => t.userId);
    expect(creators.some((id: string) => id === "user_1")).toBe(true);
    expect(creators.some((id: string) => id === "user_2")).toBe(true);
  });

  it("confirms treasury transaction idempotently: first creates, second returns final state", async () => {
    const headers = { ...(await authHeader()), "idempotency-key": "cf-1" };
    const create = await app.inject({ method: "POST", url: `/groups/group_1/treasury/deposit`, headers, body: JSON.stringify({ amount: "10", assetCode: "USDC", assetIssuer: null }) });
    expect(create.statusCode).toBe(200);
    const txId = (create.json() as any).treasuryTransaction.id;

    const confirmBody = { signedXdr: "AAAAA" };
    const r1 = await app.inject({ method: "POST", url: `/treasury-transactions/${txId}/confirm`, headers, body: JSON.stringify(confirmBody) });
    expect(r1.statusCode).toBe(200);

    const r2 = await app.inject({ method: "POST", url: `/treasury-transactions/${txId}/confirm`, headers, body: JSON.stringify(confirmBody) });
    expect(r2.statusCode).toBe(200);
  });
});