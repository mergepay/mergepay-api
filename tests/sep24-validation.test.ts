/**
 * Tests for SEP-24 request validation schemas and their wiring into the
 * anchor deposit/withdraw routes (issue #326).
 *
 * The schemas live in src/validations/sep24.ts and are applied to the shared
 * deposit/withdraw start handler in src/routes/anchors.ts. These tests verify
 * both that the schemas accept well-formed SEP-24 payloads and reject
 * malformed ones, and that the route returns a 400 VALIDATION_ERROR before any
 * upstream/anchor call when the payload does not conform.
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
    deleteMany: vi.fn(),
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
    treasuryProposal: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: model(),
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

import {
  sep24AssetCodeSchema,
  sep24InteractiveRequestSchema,
  sep24WithdrawRequestSchema,
} from "../src/validations/sep24";
import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const goodKey = Keypair.random().publicKey();
const badKey = "GCV7D6Z5MJS";

describe("sep24AssetCodeSchema", () => {
  it("accepts common asset codes and upper-cases them", () => {
    expect(sep24AssetCodeSchema.parse("usdc")).toBe("USDC");
    expect(sep24AssetCodeSchema.parse("XLM")).toBe("XLM");
  });

  it("rejects empty, too-long, or punctuated codes", () => {
    expect(sep24AssetCodeSchema.safeParse("").success).toBe(false);
    expect(sep24AssetCodeSchema.safeParse("A".repeat(13)).success).toBe(false);
    expect(sep24AssetCodeSchema.safeParse("US-C").success).toBe(false);
  });
});

describe("sep24InteractiveRequestSchema", () => {
  it("accepts a minimal deposit/withdraw start (assetCode only)", () => {
    const result = sep24InteractiveRequestSchema.safeParse({ assetCode: "USDC" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.assetCode).toBe("USDC");
  });

  it("accepts a fully-specified request", () => {
    const result = sep24InteractiveRequestSchema.safeParse({
      assetCode: "usdc",
      amount: "25.50",
      account: goodKey,
      to: goodKey,
      memo: "TAG",
      anchorName: "Test Anchor",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed Stellar account / destination", () => {
    const result = sep24InteractiveRequestSchema.safeParse({
      assetCode: "XLM",
      account: badKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive amount", () => {
    const result = sep24InteractiveRequestSchema.safeParse({
      assetCode: "XLM",
      amount: "0",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an amount with excess precision", () => {
    const result = sep24InteractiveRequestSchema.safeParse({
      assetCode: "XLM",
      amount: "1.00000008",
    });
    expect(result.success).toBe(false);
  });

  it("rejects giving a native asset an issuer", () => {
    const result = sep24InteractiveRequestSchema.safeParse({
      assetCode: "XLM",
      assetIssuer: goodKey,
    });
    expect(result.success).toBe(false);
  });
});

describe("sep24WithdrawRequestSchema", () => {
  it("requires an amount for a concrete withdrawal", () => {
    expect(sep24WithdrawRequestSchema.safeParse({ assetCode: "USDC" }).success).toBe(false);
    const ok = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "5",
      account: goodKey,
    });
    expect(ok.success).toBe(true);
  });
});

describe("POST /anchors/deposit — SEP-24 schema wiring", () => {
  const prisma = h.prisma;
  let app: Awaited<ReturnType<typeof buildApp>>;

  const authHeader = () => ({
    authorization: `Bearer ${signToken({
      id: "user_1",
      stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    })}`,
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    if (!app) app = await buildApp();
  });

  it("rejects a malformed SEP-24 account before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await app.inject({
      method: "POST",
      url: "/anchors/deposit",
      headers: authHeader(),
      payload: { assetCode: "XLM", account: badKey },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects an over-precision SEP-24 amount before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await app.inject({
      method: "POST",
      url: "/anchors/deposit",
      headers: authHeader(),
      payload: { assetCode: "XLM", amount: "1.00000008" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("VALIDATION_ERROR");
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("passes a valid SEP-24 deposit through to the anchor flow", async () => {
    const { anchorService } = await import("../src/services/anchor");
    vi.mocked(anchorService.getToml).mockResolvedValue({
      homeDomain: "testanchor.stellar.org",
      webAuthEndpoint: "https://testanchor.stellar.org/auth",
      transferServerSep24: "https://testanchor.stellar.org/sep24",
      signingKey: goodKey,
      assets: [],
    } as any);
    vi.mocked(anchorService.getChallenge).mockResolvedValue({} as any);
    prisma.anchorSession.create.mockResolvedValue({
      id: "session_1",
      userId: "user_1",
      anchorName: "Test",
      kind: "deposit",
      assetCode: "XLM",
      interactiveUrl: null,
      externalTransactionId: null,
      status: "incomplete",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/anchors/deposit",
      headers: authHeader(),
      payload: { assetCode: "XLM", amount: "5" },
    });
    expect(res.statusCode).toBe(200);
    expect(anchorService.getChallenge).toHaveBeenCalled();
  });
});