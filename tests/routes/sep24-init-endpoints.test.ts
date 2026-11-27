/**
 * Route-level coverage for SEP-24 interactive initiation.
 *
 * The service tests in tests/services/sep24-interactive-init.test.ts call
 * `initiateSep24Deposit` / `initiateSep24Withdrawal` directly, so they cannot
 * catch a handler that stops delegating, drops the challenge, or loses the
 * actor/correlation id on the way in. These cases drive the real Fastify app
 * over HTTP and assert the contract the endpoints actually publish: the
 * session envelope, the SEP-10 challenge, the audit row, and the errors.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
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

  return { prisma, getToml: vi.fn(), getChallenge: vi.fn() };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("../../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: h.getToml,
      getChallenge: h.getChallenge,
    },
  };
});

import { buildApp } from "../../src/app";
import { signToken } from "../../src/plugins/auth";
import { config } from "../../src/config";
import { AuditAction } from "../../src/services/audit-actions";

const prisma = h.prisma;

const CHALLENGE = {
  transaction: "sep10-challenge-xdr",
  networkPassphrase: "Test SDF Network ; September 2015",
};

let app: Awaited<ReturnType<typeof buildApp>>;

/** A token for a fresh user, plus the identity it carries. */
function auth() {
  const actor = {
    id: `user_${Keypair.random().publicKey().slice(0, 12)}`,
    stellarPublicKey: Keypair.random().publicKey(),
  };
  return {
    actor,
    headers: {
      authorization: `Bearer ${signToken(actor)}`,
      "content-type": "application/json",
    },
  };
}

function post(url: string, payload: unknown, headers: Record<string, string>) {
  return app.inject({ method: "POST", url, headers, payload: payload as any });
}

function lastAudit() {
  const calls = prisma.auditLog.create.mock.calls;
  return calls[calls.length - 1][0].data;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp({ rateLimit: "off" });

  h.getToml.mockResolvedValue({
    homeDomain: config.ANCHOR_HOME_DOMAIN,
    webAuthEndpoint: "https://anchor.test/auth",
    transferServerSep24: "https://anchor.test/sep24",
    signingKey: "anchor-signing-key",
    assets: [{ code: "USDC", issuer: config.STABLE_ASSET_ISSUER }],
  });
  h.getChallenge.mockResolvedValue(CHALLENGE);

  prisma.anchorSession.create.mockImplementation(async ({ data }: any) => ({
    id: "session_1",
    interactiveUrl: null,
    externalTransactionId: null,
    failureReason: null,
    retryCount: 0,
    lastPolledAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...data,
  }));
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("POST /api/sep24/deposit", () => {
  it("returns the created session and the SEP-10 challenge", async () => {
    const { actor, headers } = auth();

    const res = await post("/api/sep24/deposit", { assetCode: "USDC" }, headers);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      session: {
        id: "session_1",
        userId: actor.id,
        anchorName: config.ANCHOR_NAME,
        kind: "deposit",
        assetCode: "USDC",
        interactiveUrl: null,
        externalTransactionId: null,
        status: "incomplete",
        failureReason: null,
        retryCount: 0,
        lastPolledAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      challenge: CHALLENGE,
    });
  });

  it("requests the challenge for the authenticated caller's own account", async () => {
    const { actor, headers } = auth();

    await post("/api/sep24/deposit", { assetCode: "USDC" }, headers);

    expect(h.getToml).toHaveBeenCalledWith(config.ANCHOR_HOME_DOMAIN);
    expect(h.getChallenge).toHaveBeenCalledWith(
      "https://anchor.test/auth",
      actor.stellarPublicKey
    );
  });

  it("persists the session and its start audit row under the request id", async () => {
    const { actor, headers } = auth();

    const res = await post("/api/sep24/deposit", { assetCode: "USDC" }, headers);

    expect(prisma.anchorSession.create).toHaveBeenCalledWith({
      data: {
        userId: actor.id,
        anchorName: config.ANCHOR_NAME,
        kind: "deposit",
        assetCode: "USDC",
        status: "incomplete",
      },
    });
    expect(lastAudit()).toMatchObject({
      correlationId: res.headers["x-request-id"],
      userId: actor.id,
      action: AuditAction.ANCHOR_DEPOSIT_STARTED,
      entityType: "anchor_session",
      entityId: "session_1",
      metadata: { kind: "deposit", assetCode: "USDC" },
    });
    expect(lastAudit().metadata).not.toHaveProperty("amount");
  });

  it("canonicalises the asset code before it reaches the anchor or the database", async () => {
    const { headers } = auth();

    const res = await post("/api/sep24/deposit", { assetCode: "usdc" }, headers);

    expect(res.statusCode).toBe(200);
    expect(prisma.anchorSession.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ assetCode: "USDC" }),
    });
    expect(lastAudit().metadata).toMatchObject({ assetCode: "USDC" });
  });

  it("accepts the documented lang query parameter", async () => {
    const { headers } = auth();

    const res = await post("/api/sep24/deposit?lang=en", { assetCode: "USDC" }, headers);

    expect(res.statusCode).toBe(200);
  });
});

describe("POST /api/sep24/withdraw", () => {
  it("returns a withdrawal session carrying the requested amount", async () => {
    const { actor, headers } = auth();

    const res = await post(
      "/api/sep24/withdraw",
      { assetCode: "USDC", amount: "5.00" },
      headers
    );

    expect(res.statusCode).toBe(200);
    expect(res.json().session).toMatchObject({
      id: "session_1",
      userId: actor.id,
      kind: "withdrawal",
      assetCode: "USDC",
      status: "incomplete",
    });
    expect(res.json().challenge).toEqual(CHALLENGE);

    expect(lastAudit()).toMatchObject({
      action: AuditAction.ANCHOR_WITHDRAWAL_STARTED,
      metadata: { kind: "withdrawal", assetCode: "USDC", amount: "5.00" },
    });
  });

  it("rejects a withdrawal without an amount before contacting the anchor", async () => {
    const { headers } = auth();

    const res = await post("/api/sep24/withdraw", { assetCode: "USDC" }, headers);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(h.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });
});

describe("SEP-24 initiation guards", () => {
  it("rejects an unsupported asset without contacting the anchor", async () => {
    const { headers } = auth();

    const res = await post("/api/sep24/deposit", { assetCode: "ZZZ" }, headers);

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_ASSET");
    expect(h.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("requires a bearer token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: { "content-type": "application/json" },
      payload: { assetCode: "USDC" },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("MISSING_TOKEN");
    expect(h.getToml).not.toHaveBeenCalled();
  });

  it("rejects an unknown query parameter rather than silently dropping it", async () => {
    const { headers } = auth();

    const res = await post(
      "/api/sep24/deposit?asset_code=USDC",
      { assetCode: "USDC" },
      headers
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(h.getToml).not.toHaveBeenCalled();
  });

  it("returns an error and writes no session when the anchor challenge fails", async () => {
    const { headers } = auth();
    h.getChallenge.mockRejectedValueOnce(new Error("anchor unavailable"));

    const res = await post("/api/sep24/deposit", { assetCode: "USDC" }, headers);

    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("INTERNAL_ERROR");
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
