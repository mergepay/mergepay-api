/**
 * Issue #923 — Zod request validation middleware for the SEP-24 deposit and
 * withdraw endpoints.
 *
 * The interactive initiation routes (`/api/v1/sep24/deposit`,
 * `/api/v1/sep24/withdraw`) already parsed through `validateRequest`; the
 * Mergepay withdrawal surface (`/withdraw`, `/withdraw/:id/confirm`,
 * `/withdraw/:id`) validated inside its handlers instead. This suite drives
 * the real app and asserts, for every deposit and withdraw entry point:
 *
 *  1. the acceptance criteria's three malformed requests — a missing asset, an
 *     ill-formed Stellar public key, and a negative amount — are answered with
 *     the standard `400 VALIDATION_ERROR` envelope naming the offending field;
 *  2. a rejection stops the request at the boundary: no anchor call, no
 *     Stellar account load, no database write, no audit row;
 *  3. a well-formed request still parses through the middleware and reaches
 *     the handler — the write-back of normalised values must not break the
 *     happy path, and the handler's own error codes (`INVALID_AMOUNT`) must
 *     still win where the shape schema deliberately stops short.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
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
    anchorSession: model(),
    withdrawal: model(),
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

vi.mock("../src/services/stellar", () => ({
  stellar: {
    loadAccount: vi.fn(),
    buildPayment: vi.fn(),
    submitPayment: vi.fn(),
    submitSigned: vi.fn(),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
  toAsset: vi.fn(),
}));

vi.mock("../src/services/anchor", () => ({
  anchorService: {
    getToml: vi.fn(),
    getChallenge: vi.fn(),
    getToken: vi.fn(),
    startInteractive: vi.fn(),
  },
  mapAnchorStatus: vi.fn((s: string) => s),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";
import { stellar } from "../src/services/stellar";
import { anchorService } from "../src/services/anchor";

const prisma = h.prisma;

const fakeUser = () => ({
  id: "user_923",
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "SEP-24 tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

/** The fields a 400 VALIDATION_ERROR named, from the shared error envelope. */
function failedFields(body: any): string[] {
  return (body.error?.details ?? []).map((detail: any) => detail.field);
}

/** Assert the standard validation envelope, and that it names `field`. */
function expectValidationEnvelope(res: { statusCode: number; json: () => any }, field: string) {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(Array.isArray(body.error.details)).toBe(true);
  expect(body.error.details.length).toBeGreaterThan(0);
  expect(Array.isArray(body.error.issues)).toBe(true);

  const named =
    body.error.details.some((d: any) => d.field === field) ||
    body.error.issues.some((i: any) => i.path.join(".") === field);
  expect(named, `expected the rejection to name "${field}"`).toBe(true);
  return body;
}

/** Nothing upstream or persistent may be touched on the rejection path. */
function expectNoSideEffects() {
  expect(anchorService.getToml).not.toHaveBeenCalled();
  expect(anchorService.getChallenge).not.toHaveBeenCalled();
  expect(anchorService.getToken).not.toHaveBeenCalled();
  expect(anchorService.startInteractive).not.toHaveBeenCalled();
  expect(stellar.loadAccount).not.toHaveBeenCalled();
  expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  expect(prisma.withdrawal.create).not.toHaveBeenCalled();
  expect(prisma.auditLog.create).not.toHaveBeenCalled();
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  // The suite asserts validation, not throttling, so it boots without the
  // limiter as CONTRIBUTING directs (#658): one reused app must not answer a
  // later assertion with a 429.
  if (!app) app = await buildApp({ rateLimit: "off" });

  vi.mocked(anchorService.getToml).mockResolvedValue({
    homeDomain: "testanchor.stellar.org",
    webAuthEndpoint: "https://testanchor.stellar.org/auth",
    transferServerSep24: "https://testanchor.stellar.org/sep24",
    signingKey: Keypair.random().publicKey(),
    assets: [],
  } as any);
  vi.mocked(anchorService.getChallenge).mockResolvedValue({
    transaction: "challenge-xdr",
  } as any);
  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [{ assetCode: "XLM", assetIssuer: null, balance: "100.0000000" }],
    signers: [],
    thresholds: { low: 1, med: 1, high: 1 },
  } as any);
  prisma.anchorSession.create.mockImplementation(async ({ data }: any) => ({
    id: `session_${Math.random().toString(16).slice(2, 8)}`,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    interactiveUrl: null,
    externalTransactionId: null,
    ...data,
  }));
  prisma.withdrawal.create.mockImplementation(async ({ data }: any) => ({
    id: "wth_923",
    anchorTxId: null,
    interactiveUrl: null,
    status: "pending",
    failureReason: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...data,
  }));
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

// ─── Acceptance criteria: the three malformed request shapes ────────────────

describe("invalid parameters are rejected at the boundary (#923)", () => {
  it("rejects a deposit with a missing asset code", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sep24/deposit",
      headers: authHeader(),
      payload: { account: Keypair.random().publicKey(), amount: "10" },
    });

    expectValidationEnvelope(res, "assetCode");
    expectNoSideEffects();
  });

  it("rejects a deposit whose account is not a Stellar public key", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sep24/deposit",
      headers: authHeader(),
      payload: { assetCode: "USDC", account: "G_NOT_A_VALID_STELLAR_KEY" },
    });

    expectValidationEnvelope(res, "account");
    expectNoSideEffects();
  });

  it("rejects a withdrawal with a negative amount", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/sep24/withdraw",
      headers: authHeader(),
      payload: { assetCode: "USDC", amount: "-10.5" },
    });

    expectValidationEnvelope(res, "amount");
    expectNoSideEffects();
  });
});

// ─── The withdrawal surface, now guarded by the same middleware ─────────────

describe("POST /withdraw — validated by the preHandler (#923)", () => {
  it("rejects a missing asset code before the handler runs", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "10" },
    });

    expectValidationEnvelope(res, "assetCode");
    // The handler's own work — the balance lookup — must never start.
    expectNoSideEffects();
  });

  it("rejects a negative amount with the standard envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "-5", assetCode: "XLM" },
    });

    expectValidationEnvelope(res, "amount");
    expectNoSideEffects();
  });

  it("keeps the handler's error code for an amount the shape schema allows", async () => {
    // "0" is a well-formed decimal, so the schema stops short of judging it
    // and the handler answers its own code — the middleware must not swallow it.
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "0", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_AMOUNT");
    expect(prisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("still starts a withdrawal for a well-formed payload", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "5", assetCode: "XLM", memo: "MP:ABC123DEF0" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction_id).toBe("wth_923");
    expect(body.status).toBe("pending");
    expect(body.withdrawal.amount).toBe("5");
    expect(prisma.withdrawal.create).toHaveBeenCalledOnce();
    expect(prisma.auditLog.create).toHaveBeenCalled();
  });
});

describe("POST /withdraw/:id/confirm — validated by the preHandler (#923)", () => {
  it("rejects a body that is not a signed envelope before the anchor is contacted", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/withdraw/wth_923/confirm",
      headers: authHeader(),
      payload: { signedXdr: "not-xdr!!" },
    });

    expectValidationEnvelope(res, "signedXdr");
    expectNoSideEffects();
  });

  it("rejects a missing body with the standard envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/withdraw/wth_923/confirm",
      headers: authHeader(),
      payload: {},
    });

    expectValidationEnvelope(res, "signedXdr");
    expectNoSideEffects();
  });
});

describe("GET /withdraw/:id — validated by the preHandler (#923)", () => {
  it("reads a withdrawal the caller owns through the parsed path parameter", async () => {
    const user = fakeUser();
    prisma.withdrawal.findUnique.mockResolvedValueOnce({
      id: "wth_923",
      userId: user.id,
      amount: "5",
      assetCode: "XLM",
      memo: null,
      anchorTxId: null,
      interactiveUrl: null,
      status: "pending",
      failureReason: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/withdraw/wth_923",
      headers: authHeader(user),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.withdrawal.id).toBe("wth_923");
    expect(body.transaction_id).toBeNull();
    expect(prisma.withdrawal.findUnique).toHaveBeenCalledWith({
      where: { id: "wth_923" },
    });
  });
});
