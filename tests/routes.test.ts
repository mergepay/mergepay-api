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
    expect(body.statusCode).toBe(400);
    expect(body.requestId).toBeTruthy();
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
    expect(body.requestId).toBeTruthy();
  });

  it("GET /me returns the user with a valid token", async () => {
    const user = fakeUser();
    prisma.user.findUnique.mockResolvedValueOnce(user);
    const res = await app.inject({
      method: "GET",
      url: "/me",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(user.id);
  });
});

describe("group routes", () => {
  it("POST /groups creates a group and admin membership", async () => {
    const user = fakeUser();
    const group = {
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: user.id,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    };
    prisma.group.create.mockResolvedValueOnce(group);
    prisma.auditLog.create.mockResolvedValueOnce({});

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(user),
      payload: { name: "Trip" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().group.name).toBe("Trip");
    expect(prisma.group.create).toHaveBeenCalledOnce();
  });

  it("POST /groups validates the body", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "" },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("VALIDATION_ERROR");
    expect(body.statusCode).toBe(400);
    expect(body.requestId).toBeTruthy();
    expect(Array.isArray(body.details)).toBe(true);
  });

  it("GET /groups/:id returns 403 for a non-member", async () => {
    prisma.groupMember.findUnique.mockResolvedValueOnce(null);
    prisma.group.findUnique.mockResolvedValueOnce({ id: "group_x" });
    const res = await app.inject({
      method: "GET",
      url: "/groups/group_x",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(403);
    const body = res.json();
    expect(body.error).toBe("FORBIDDEN");
    expect(body.statusCode).toBe(403);
    expect(body.requestId).toBeTruthy();
  });

  it("GET /groups/:id returns the detail for a member", async () => {
    const user = fakeUser();
    prisma.groupMember.findUnique.mockResolvedValueOnce({
      groupId: "group_1",
      userId: user.id,
      role: "admin",
    });
    prisma.group.findUnique.mockResolvedValueOnce({
      id: "group_1",
      name: "Trip",
      description: null,
      createdByUserId: user.id,
      treasuryEnabled: false,
      treasuryAccountPublicKey: null,
      treasuryRequiredSigners: null,
      archived: false,
      createdAt: new Date("2026-02-01T00:00:00.000Z"),
    });
    prisma.groupMember.findMany.mockResolvedValueOnce([
      {
        id: "m1",
        groupId: "group_1",
        userId: user.id,
        role: "admin",
        joinedAt: new Date("2026-02-01T00:00:00.000Z"),
        user,
      },
    ]);

    const res = await app.inject({
      method: "GET",
      url: "/groups/group_1",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.yourRole).toBe("admin");
    expect(body.members).toHaveLength(1);
  });
});
