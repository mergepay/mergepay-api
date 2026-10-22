/**
 * Issue #366 — Zod request validation for the SEP-24 deposit and withdrawal
 * endpoints (and their status reads).
 *
 * Covers, at the route level via `app.inject`:
 *
 *  1. Valid deposit/withdrawal starts pass through to the anchor flow
 *  2. Missing or empty required parameters are rejected with a structured
 *     400 VALIDATION_ERROR before any anchor I/O happens
 *  3. Malformed Stellar public keys (bad format or bad checksum) are rejected
 *  4. Memo/memoType pairing and supported-asset rules are enforced
 *  5. Status endpoints validate their query parameters with the same contract
 *
 * The schemas themselves live in src/validations/sep24.ts (re-exported from
 * src/schemas/sep24.ts) and are applied inside the handlers in
 * src/routes/anchors.ts — openApiBody is documentation-only, so Zod is the
 * single gate and every rejection surfaces the shared VALIDATION_ERROR shape.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    count: vi.fn(async () => 1),
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

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const userKey = Keypair.random().publicKey();

const authHeader = () => ({
  authorization: `Bearer ${signToken({
    id: "user_1",
    stellarPublicKey: userKey,
  })}`,
});

/** A full-length key whose final character breaks the ed25519 checksum. */
function checksumBrokenKey(): string {
  const key = Keypair.random().publicKey();
  const last = key.slice(-1);
  return key.slice(0, -1) + (last === "A" ? "B" : "A");
}

const createdSession = (kind: string, over: Record<string, any> = {}) => ({
  id: `session_${kind}_1`,
  userId: "user_1",
  anchorName: config.ANCHOR_NAME,
  kind,
  assetCode: "XLM",
  interactiveUrl: null,
  externalTransactionId: null,
  status: "incomplete",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  vi.mocked(anchorService.getToml).mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://testanchor.stellar.org/auth",
    transferServerSep24: "https://testanchor.stellar.org/sep24",
    signingKey: userKey,
    assets: [],
  } as any);
  vi.mocked(anchorService.getChallenge).mockResolvedValue({
    transaction: "challenge-xdr",
  } as any);
  prisma.anchorSession.findMany.mockResolvedValue([]);
  prisma.anchorSession.create.mockImplementation(
    async ({ data }: any) => createdSession(data.kind, data)
  );
  prisma.auditLog.create.mockResolvedValue({});
});

function post(url: string, payload: unknown) {
  return app.inject({ method: "POST", url, headers: authHeader(), payload: payload as any });
}

/** Shared assertions for a structured Zod rejection. */
function expectValidation400(res: { statusCode: number; json: () => any }) {
  const body = res.json();
  expect(res.statusCode).toBe(400);
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.error.code).toBe("VALIDATION_ERROR");
  expect(typeof body.message).toBe("string");
  expect(Array.isArray(body.error.details)).toBe(true);
  expect(body.error.details.length).toBeGreaterThan(0);
}

describe("POST /anchors/deposit — request validation", () => {
  it("accepts a valid deposit start and creates a session", async () => {
    const res = await post("/anchors/deposit", {
      assetCode: "XLM",
      amount: "5",
      memo: "TAG",
      memoType: "text",
      walletName: "Mergepay Wallet",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().session).toBeTruthy();
    expect(res.json().challenge).toBeTruthy();
    expect(prisma.anchorSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "deposit", assetCode: "XLM" }),
      })
    );
    expect(anchorService.getChallenge).toHaveBeenCalled();
  });

  it("rejects a deposit with no required parameters before any anchor call", async () => {
    const res = await post("/anchors/deposit", {});

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects an empty asset code before any anchor call", async () => {
    const res = await post("/anchors/deposit", { assetCode: "" });

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects a checksum-invalid Stellar account before any anchor call", async () => {
    const res = await post("/anchors/deposit", {
      assetCode: "XLM",
      account: checksumBrokenKey(),
    });

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects a memo supplied without a memoType", async () => {
    const res = await post("/anchors/deposit", { assetCode: "XLM", memo: "TAG" });

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects a well-formed but unsupported asset code", async () => {
    const res = await post("/anchors/deposit", { assetCode: "ZZZ" });

    expect(res.statusCode).toBe(400);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });
});

describe("POST /anchors/withdraw — request validation", () => {
  it("accepts a valid withdrawal start and records the session kind", async () => {
    const res = await post("/anchors/withdraw", {
      assetCode: "XLM",
      amount: "5",
      to: userKey,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: "withdrawal" }),
      })
    );
  });

  it("rejects a malformed destination key before any anchor call", async () => {
    const res = await post("/anchors/withdraw", {
      assetCode: "XLM",
      amount: "5",
      to: "not-a-stellar-account",
    });

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects a withdrawal without an amount before any anchor call", async () => {
    const res = await post("/anchors/withdraw", { assetCode: "XLM", to: userKey });

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects unknown withdrawal fields before any anchor call", async () => {
    const res = await post("/anchors/withdraw", {
      assetCode: "XLM",
      amount: "5",
      unexpected: true,
    });

    expectValidation400(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });
});

describe("SEP-24 session status — query validation", () => {
  it("lists sessions with a valid query", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/anchors/sessions",
      headers: authHeader(),
    });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().sessions)).toBe(true);
  });

  it("rejects an out-of-range limit with a structured 400", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/anchors/sessions?limit=0",
      headers: authHeader(),
    });

    expectValidation400(res);
    expect(prisma.anchorSession.findMany).not.toHaveBeenCalled();
  });
});
