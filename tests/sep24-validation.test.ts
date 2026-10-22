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
      memoType: "text",
      anchorName: "Test Anchor",
    });
    expect(result.success).toBe(true);
  });

  it("requires memo and memoType to be supplied together (issue #366)", () => {
    // memo without memoType — an anchor cannot classify it.
    expect(
      sep24InteractiveRequestSchema.safeParse({ assetCode: "XLM", memo: "TAG" })
        .success
    ).toBe(false);
    // memoType without memo — nothing to apply it to.
    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "XLM",
        memoType: "text",
      }).success
    ).toBe(false);
    // Both together, with a supported memo type, is valid.
    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "XLM",
        memo: "TAG",
        memoType: "text",
      }).success
    ).toBe(true);
    // An unsupported memo type is rejected even with a memo.
    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "XLM",
        memo: "TAG",
        memoType: "binary",
      }).success
    ).toBe(false);
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

  it("rejects unknown request fields", () => {
    const result = sep24InteractiveRequestSchema.safeParse({
      assetCode: "XLM",
      unexpected: true,
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

  it("rejects unknown withdrawal fields", () => {
    const result = sep24WithdrawRequestSchema.safeParse({
      assetCode: "USDC",
      amount: "5",
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("SEP-24 issuer, memo and extraMetadata validation (issue #535)", () => {
  const hashMemo = Buffer.alloc(32, 7).toString("base64");
  const parse = (fields: Record<string, unknown>) =>
    sep24InteractiveRequestSchema.safeParse({ assetCode: "USDC", ...fields });
  const firstIssue = (fields: Record<string, unknown>) => {
    const result = parse(fields);
    return result.success ? undefined : result.error.issues[0];
  };

  it("accepts a valid Stellar public key or null as assetIssuer", () => {
    expect(parse({ assetIssuer: goodKey }).success).toBe(true);
    expect(parse({ assetIssuer: null }).success).toBe(true);
  });

  it("rejects an assetIssuer that is not a Stellar public key", () => {
    expect(firstIssue({ assetIssuer: badKey })?.path).toEqual(["assetIssuer"]);
    expect(parse({ assetIssuer: "" }).success).toBe(false);
    expect(parse({ assetIssuer: "G".repeat(10_000) }).success).toBe(false);
    // A secret seed must never be accepted in place of the issuer.
    expect(parse({ assetIssuer: Keypair.random().secret() }).success).toBe(false);
  });

  it("accepts text memos with spaces and non-ASCII up to 28 UTF-8 bytes", () => {
    expect(parse({ memo: "invoice 42 - june", memoType: "text" }).success).toBe(true);
    expect(parse({ memo: "a".repeat(28), memoType: "text" }).success).toBe(true);
    expect(parse({ memo: "café", memoType: "text" }).success).toBe(true);
  });

  it("rejects text memos over 28 UTF-8 bytes or with control characters", () => {
    expect(firstIssue({ memo: "a".repeat(29), memoType: "text" })?.path).toEqual(["memo"]);
    // 14 two-byte characters: 14 chars but 28 bytes is fine, 15 is not.
    expect(parse({ memo: "é".repeat(14), memoType: "text" }).success).toBe(true);
    expect(parse({ memo: "é".repeat(15), memoType: "text" }).success).toBe(false);
    expect(parse({ memo: "line\nbreak", memoType: "text" }).success).toBe(false);
    expect(parse({ memo: "nul\u0000", memoType: "text" }).success).toBe(false);
  });

  it("accepts id memos within the unsigned 64-bit range", () => {
    expect(parse({ memo: "0", memoType: "id" }).success).toBe(true);
    expect(parse({ memo: "18446744073709551615", memoType: "id" }).success).toBe(true);
  });

  it("rejects id memos that are not unsigned 64-bit integers", () => {
    expect(firstIssue({ memo: "18446744073709551616", memoType: "id" })?.path).toEqual([
      "memo",
    ]);
    expect(parse({ memo: "-1", memoType: "id" }).success).toBe(false);
    expect(parse({ memo: "12.5", memoType: "id" }).success).toBe(false);
    expect(parse({ memo: "abc", memoType: "id" }).success).toBe(false);
  });

  it("accepts a base64-encoded 32-byte hash memo", () => {
    expect(parse({ memo: hashMemo, memoType: "hash" }).success).toBe(true);
  });

  it("rejects hash memos that are not base64-encoded 32-byte values", () => {
    expect(firstIssue({ memo: "TAG", memoType: "hash" })?.path).toEqual(["memo"]);
    expect(parse({ memo: "a".repeat(64), memoType: "hash" }).success).toBe(false);
    expect(
      parse({ memo: Buffer.alloc(31).toString("base64"), memoType: "hash" }).success
    ).toBe(false);
  });

  it("applies the same memo-type rules to refundMemo", () => {
    expect(
      parse({ refundMemo: "refund 7", refundMemoType: "text" }).success
    ).toBe(true);
    expect(
      firstIssue({ refundMemo: "not-a-number", refundMemoType: "id" })?.path
    ).toEqual(["refundMemo"]);
    expect(parse({ refundMemo: hashMemo, refundMemoType: "hash" }).success).toBe(true);
  });

  it("rejects any memo longer than the longest valid memo", () => {
    expect(parse({ memo: "a".repeat(45), memoType: "hash" }).success).toBe(false);
  });

  it("accepts a small extraMetadata object", () => {
    expect(parse({ extraMetadata: { source: "mobile", version: 3 } }).success).toBe(true);
  });

  it("rejects extraMetadata with too many keys or too large a payload", () => {
    const manyKeys = Object.fromEntries(
      Array.from({ length: 21 }, (_, i) => [`k${i}`, i])
    );
    expect(firstIssue({ extraMetadata: manyKeys })?.path).toEqual(["extraMetadata"]);
    expect(
      parse({ extraMetadata: { blob: "x".repeat(4096) } }).success
    ).toBe(false);
    expect(
      parse({ extraMetadata: { nested: { deep: ["x".repeat(3000)] } } }).success
    ).toBe(false);
  });

  it("enforces the same rules on the withdrawal schema", () => {
    const base = { assetCode: "USDC", amount: "5" };
    expect(
      sep24WithdrawRequestSchema.safeParse({ ...base, assetIssuer: badKey }).success
    ).toBe(false);
    expect(
      sep24WithdrawRequestSchema.safeParse({ ...base, memo: "abc", memoType: "id" }).success
    ).toBe(false);
    expect(
      sep24WithdrawRequestSchema.safeParse({
        ...base,
        extraMetadata: { blob: "x".repeat(4096) },
      }).success
    ).toBe(false);
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
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
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
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
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

describe("POST /api/sep24/deposit & POST /api/sep24/withdraw — SEP-24 route validation", () => {
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

  it("rejects invalid refundMemo or refundMemoType pairing", () => {
    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "USDC",
        refundMemo: "REFUND1",
      }).success
    ).toBe(false);

    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "USDC",
        refundMemoType: "text",
      }).success
    ).toBe(false);

    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "USDC",
        refundMemo: "REFUND1",
        refundMemoType: "text",
      }).success
    ).toBe(true);
  });

  it("POST /api/sep24/deposit — returns 400 for malformed assetCode", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeader(),
      payload: { assetCode: "INVALID_CODE_TOO_LONG" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/sep24/withdraw — returns 400 when amount is missing for withdrawal", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/withdraw",
      headers: authHeader(),
      payload: { assetCode: "USDC" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("POST /api/sep24/deposit — returns 400 for a malformed assetIssuer before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeader(),
      payload: { assetCode: "USDC", assetIssuer: "not-a-stellar-key" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("POST /api/sep24/deposit — returns 400 for a memo that does not match its memoType", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeader(),
      payload: { assetCode: "USDC", memo: "not-an-id", memoType: "id" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("POST /api/sep24/withdraw — returns 400 for oversized extraMetadata before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/withdraw",
      headers: authHeader(),
      payload: {
        assetCode: "USDC",
        amount: "5",
        extraMetadata: { blob: "x".repeat(4096) },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("POST /api/sep24/deposit — accepts valid payload and initiates session", async () => {
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
      id: "session_sep24_1",
      userId: "user_1",
      anchorName: "Test",
      kind: "deposit",
      assetCode: "USDC",
      interactiveUrl: null,
      externalTransactionId: null,
      status: "incomplete",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    prisma.auditLog.create.mockResolvedValue({});

    const res = await app.inject({
      method: "POST",
      url: "/api/sep24/deposit",
      headers: authHeader(),
      payload: { assetCode: "USDC", amount: "10.00" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().session).toBeDefined();
  });
});