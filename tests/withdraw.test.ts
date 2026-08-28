import { describe, it, expect, beforeEach, vi } from "vitest";

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
    treasuryProposal: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
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
    getToken: vi.fn(),
    startInteractive: vi.fn(),
  },
  mapAnchorStatus: vi.fn((s: string) => s),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;

const fakeUser = (over: Partial<any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  // Default: anchor TOML works.
  const { stellar } = await import("../src/services/stellar");
  const { anchorService } = await import("../src/services/anchor");
  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [
      { assetCode: "XLM", assetIssuer: null, balance: "100.0000000" },
      {
        assetCode: "USDC",
        assetIssuer: "GISSUER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        balance: "50.0000000",
      },
    ],
    signers: [{ key: "GA", weight: 1 }],
    thresholds: { low: 1, med: 1, high: 1 },
  });
  vi.mocked(anchorService.getToml).mockResolvedValue({
    homeDomain: "testanchor.stellar.org",
    webAuthEndpoint: "https://testanchor.stellar.org/auth",
    transferServerSep24: "https://testanchor.stellar.org/sep24",
    signingKey: "GA",
    assets: [],
  });
});

describe("POST /withdraw", () => {
  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      payload: { amount: "10", assetCode: "USDC" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("returns 400 for a non-positive amount", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "0", assetCode: "XLM" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_AMOUNT");
  });

  it("returns 400 for an unsupported asset", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "1", assetCode: "BTC" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNSUPPORTED_ASSET");
  });

  it("returns 400 for insufficient balance", async () => {
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValueOnce({
      exists: true,
      sequence: "12345",
      balances: [
        { assetCode: "XLM", assetIssuer: null, balance: "1.0000000" },
      ],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "10", assetCode: "XLM" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INSUFFICIENT_BALANCE");
  });

  it("creates a Withdrawal and returns the interactive_url/transaction_id/status shape", async () => {
    const user = fakeUser();
    const withdrawal = {
      id: "wth_1",
      userId: user.id,
      amount: "5",
      assetCode: "XLM",
      assetIssuer: null,
      memo: null,
      anchorTxId: null,
      interactiveUrl:
        "https://testanchor.stellar.org/sep24/withdraw?asset_code=XLM&account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&amount=5",
      status: "pending",
      failureReason: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    };
    prisma.withdrawal.create.mockResolvedValueOnce(withdrawal);
    prisma.auditLog.create.mockResolvedValueOnce({});

    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(user),
      payload: { amount: "5", assetCode: "XLM", memo: "rent" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.transaction_id).toBe("wth_1");
    expect(body.status).toBe("pending");
    expect(body.interactive_url).toMatch(
      /^https:\/\/testanchor\.stellar\.org\/sep24\/withdraw\?/
    );
    expect(body.interactive_url).toContain("asset_code=XLM");
    expect(body.withdrawal.id).toBe("wth_1");
    expect(prisma.withdrawal.create).toHaveBeenCalledOnce();
  });

  it("returns 400 when no trustline for the requested asset", async () => {
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValueOnce({
      exists: true,
      sequence: "1",
      balances: [{ assetCode: "XLM", assetIssuer: null, balance: "100" }],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "1", assetCode: "USDC" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("NO_TRUSTLINE");
  });

  it("returns 400 for an unfunded account", async () => {
    const { stellar } = await import("../src/services/stellar");
    vi.mocked(stellar.loadAccount).mockResolvedValueOnce({
      exists: false,
      sequence: "0",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    });
    const res = await app.inject({
      method: "POST",
      url: "/withdraw",
      headers: authHeader(),
      payload: { amount: "1", assetCode: "XLM" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("ACCOUNT_UNFUNDED");
  });
});

describe("POST /withdraw/:id/confirm", () => {
  const pendingWithdrawal = (over: Partial<any> = {}) => ({
    id: "wth_1",
    userId: "user_1",
    amount: "5",
    assetCode: "XLM",
    assetIssuer: null,
    memo: null,
    anchorTxId: null,
    interactiveUrl: "https://testanchor.stellar.org/sep24/withdraw",
    status: "pending",
    failureReason: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    ...over,
  });

  it("moves a pending withdrawal to processing and stores the anchor tx id", async () => {
    const user = fakeUser();
    const { anchorService } = await import("../src/services/anchor");
    vi.mocked(anchorService.getToken).mockResolvedValueOnce("anchor-jwt");
    vi.mocked(anchorService.startInteractive).mockResolvedValueOnce({
      url: "https://testanchor.stellar.org/sep24/interactive/abc",
      id: "ANCH-TX-1",
    });

    prisma.withdrawal.findUnique
      .mockResolvedValueOnce(pendingWithdrawal())
      .mockResolvedValueOnce(pendingWithdrawal())
      .mockResolvedValueOnce(
        pendingWithdrawal({ status: "processing", anchorTxId: "ANCH-TX-1" })
      );

    const res = await app.inject({
      method: "POST",
      url: "/withdraw/wth_1/confirm",
      headers: authHeader(user),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("processing");
    expect(body.transaction_id).toBe("ANCH-TX-1");
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_1", status: "pending" },
      data: { anchorTxId: "ANCH-TX-1", status: "processing" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "withdrawal.status_changed",
        entityType: "withdrawal",
        entityId: "wth_1",
        metadata: { from: "pending", to: "processing", source: "user" },
      }),
    });
  });

  it("marks the withdrawal failed when the anchor call errors, without leaking the error upstream", async () => {
    const user = fakeUser();
    const { anchorService } = await import("../src/services/anchor");
    vi.mocked(anchorService.getToken).mockRejectedValueOnce(new Error("network down"));

    prisma.withdrawal.findUnique
      .mockResolvedValueOnce(pendingWithdrawal())
      .mockResolvedValueOnce(pendingWithdrawal())
      .mockResolvedValueOnce(pendingWithdrawal({ status: "failed" }));

    const res = await app.inject({
      method: "POST",
      url: "/withdraw/wth_1/confirm",
      headers: authHeader(user),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(502);
    expect(prisma.withdrawal.updateMany).toHaveBeenCalledWith({
      where: { id: "wth_1", status: "pending" },
      data: { status: "failed" },
    });
  });

  it("is idempotent for a repeated confirm on an already non-pending withdrawal", async () => {
    const user = fakeUser();
    const { anchorService } = await import("../src/services/anchor");
    prisma.withdrawal.findUnique.mockResolvedValueOnce(
      pendingWithdrawal({ status: "processing", anchorTxId: "ANCH-TX-1" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/withdraw/wth_1/confirm",
      headers: authHeader(user),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("processing");
    expect(anchorService.getToken).not.toHaveBeenCalled();
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown withdrawal id", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce(null);

    const res = await app.inject({
      method: "POST",
      url: "/withdraw/missing/confirm",
      headers: authHeader(),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 rather than confirming a withdrawal owned by another user", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce(
      pendingWithdrawal({ userId: "someone_else" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/withdraw/wth_1/confirm",
      headers: authHeader(fakeUser({ id: "user_1" })),
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(404);
    expect(prisma.withdrawal.updateMany).not.toHaveBeenCalled();
  });
});

describe("GET /withdraw/:id", () => {
  it("returns the withdrawal for the owning user", async () => {
    const user = fakeUser();
    prisma.withdrawal.findUnique.mockResolvedValueOnce({
      id: "wth_1",
      userId: user.id,
      amount: "5",
      assetCode: "XLM",
      assetIssuer: null,
      memo: null,
      anchorTxId: "ANCH-TX-1",
      interactiveUrl: null,
      status: "completed",
      failureReason: null,
      createdAt: new Date("2026-04-01T00:00:00.000Z"),
      updatedAt: new Date("2026-04-01T00:00:00.000Z"),
    });

    const res = await app.inject({
      method: "GET",
      url: "/withdraw/wth_1",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.withdrawal.id).toBe("wth_1");
    expect(body.withdrawal.anchorTxId).toBe("ANCH-TX-1");
    expect(body.withdrawal.status).toBe("completed");
  });

  it("returns 404 when the withdrawal doesn't exist", async () => {
    prisma.withdrawal.findUnique.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: "GET",
      url: "/withdraw/missing",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns 403 when the user doesn't own the withdrawal", async () => {
    const user = fakeUser({ id: "user_1" });
    prisma.withdrawal.findUnique.mockResolvedValueOnce({
      id: "wth_1",
      userId: "user_2",
      amount: "5",
      assetCode: "XLM",
      assetIssuer: null,
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
      url: "/withdraw/wth_1",
      headers: authHeader(user),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });
});
