/**
 * SEP-24 deposit and withdraw *request* validation (Issue #511).
 *
 * The initiation endpoints — `POST /anchors/deposit`, `POST /anchors/withdraw`
 * (shared start handler, src/routes/anchors.ts) and the concrete
 * `POST /withdraw` (src/routes/withdraw.ts) — validate their bodies with the
 * shared Zod schemas in src/validations/sep24.ts before any anchor, Horizon,
 * or database call:
 *
 *   - required fields (asset code, amount) are enforced,
 *   - asset codes must be alphanumeric and at most 12 characters,
 *   - amounts must be decimals with at most 7 fractional digits,
 *   - Stellar accounts are checksum-validated,
 *   - unexpected fields are rejected outright (strict objects).
 *
 * Every rejection is the project's structured 400 VALIDATION_ERROR, asserted
 * here together with the fact that no upstream/DB call happened.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
  });
  const prisma: any = {
    anchorSession: model(),
    withdrawal: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/anchor", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/anchor")>();
  return {
    ...actual,
    anchorService: {
      ...actual.anchorService,
      getToml: vi.fn(),
      getChallenge: vi.fn(),
      getToken: vi.fn(),
      startInteractive: vi.fn(),
    },
  };
});

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

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import {
  sep24InteractiveRequestSchema,
  sep24WithdrawRequestSchema,
} from "../src/validations/sep24";

const prisma = h.prisma;
const goodKey = Keypair.random().publicKey();
const badKey = "GCV7D6Z5MJS";

let app: Awaited<ReturnType<typeof buildApp>>;

/** Each case sends from its own address so rate-limit budgets never bleed. */
let clientAddress = 0;
function nextIp(): string {
  clientAddress += 1;
  return `10.8.${Math.floor(clientAddress / 256)}.${clientAddress % 256}`;
}

let userSeq = 0;

function authHeader(userId = "user_1") {
  return {
    authorization: `Bearer ${signToken({
      id: userId,
      stellarPublicKey: goodKey,
    })}`,
  };
}

function expectValidationError(res: { statusCode: number; json: () => any }) {
  expect(res.statusCode).toBe(400);
  const body = res.json();
  expect(body.code).toBe("VALIDATION_ERROR");
  expect(body.error).toBe("VALIDATION_ERROR");
  expect(typeof body.message).toBe("string");
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  const { anchorService } = await import("../src/services/anchor");
  const { stellar } = await import("../src/services/stellar");

  vi.mocked(anchorService.getToml).mockResolvedValue({
    homeDomain: "testanchor.stellar.org",
    webAuthEndpoint: "https://testanchor.stellar.org/auth",
    transferServerSep24: "https://testanchor.stellar.org/sep24",
    signingKey: goodKey,
    assets: [],
  } as any);
  vi.mocked(anchorService.getChallenge).mockResolvedValue({} as any);

  vi.mocked(stellar.loadAccount).mockResolvedValue({
    exists: true,
    sequence: "12345",
    balances: [{ assetCode: "XLM", assetIssuer: null, balance: "100.0000000" }],
    signers: [],
    thresholds: { low: 1, med: 1, high: 1 },
  } as any);

  prisma.anchorSession.create.mockResolvedValue({
    id: "session_1",
    userId: "user_1",
    anchorName: "Test Anchor",
    kind: "deposit",
    assetCode: "XLM",
    interactiveUrl: null,
    externalTransactionId: null,
    status: "incomplete",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  prisma.withdrawal.create.mockResolvedValue({
    id: "wth_1",
    userId: "user_1",
    amount: "5",
    assetCode: "XLM",
    memo: null,
    status: "pending",
    interactiveUrl: "https://testanchor.stellar.org/sep24/withdraw",
    anchorTxId: null,
    failureReason: null,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  });
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

async function postAnchors(path: string, payload: unknown) {
  // The anchor-init rate limit is keyed by user; each case uses its own
  // identity so one test's budget can never bleed into the next.
  userSeq += 1;
  return app.inject({
    method: "POST",
    url: path,
    headers: authHeader(`user_${userSeq}`),
    payload: payload as any,
    remoteAddress: nextIp(),
  });
}

async function postWithdraw(payload: unknown) {
  return app.inject({
    method: "POST",
    url: "/withdraw",
    headers: authHeader(),
    payload: payload as any,
    remoteAddress: nextIp(),
  });
}

describe("SEP-24 request schemas — strict objects", () => {
  it("sep24InteractiveRequestSchema accepts known fields and rejects unknown ones", () => {
    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "USDC",
        amount: "25.5",
        account: goodKey,
        memo: "TAG",
        anchorName: "Test Anchor",
      }).success
    ).toBe(true);

    expect(
      sep24InteractiveRequestSchema.safeParse({
        assetCode: "USDC",
        amountt: "25.5", // misspelled field must not be silently dropped
      }).success
    ).toBe(false);
  });

  it("sep24WithdrawRequestSchema stays strict while still requiring its amount", () => {
    expect(
      sep24WithdrawRequestSchema.safeParse({ assetCode: "USDC", amount: "5" })
        .success
    ).toBe(true);
    expect(
      sep24WithdrawRequestSchema.safeParse({
        assetCode: "USDC",
        amount: "5",
        unexpected: true,
      }).success
    ).toBe(false);
    expect(
      sep24WithdrawRequestSchema.safeParse({ assetCode: "USDC" }).success
    ).toBe(false);
  });
});

describe("POST /anchors/deposit — request validation", () => {
  it("accepts a valid deposit request", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/deposit", { assetCode: "XLM" });

    expect(res.statusCode).toBe(200);
    expect(anchorService.getToml).toHaveBeenCalled();
  });

  it("rejects a missing asset code before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/deposit", { amount: "5" });

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });

  it("rejects a malformed asset code before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/deposit", { assetCode: "US-C" });

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects a malformed Stellar account before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/deposit", {
      assetCode: "XLM",
      account: badKey,
    });

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects a negative or over-precise amount before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");

    const negative = await postAnchors("/anchors/deposit", {
      assetCode: "XLM",
      amount: "-5",
    });
    expectValidationError(negative);

    const overPrecise = await postAnchors("/anchors/deposit", {
      assetCode: "XLM",
      amount: "1.00000008",
    });
    expectValidationError(overPrecise);

    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects an unexpected field instead of silently stripping it", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/deposit", {
      assetCode: "XLM",
      amountt: "5", // misspelled amount must be a 400, not a dropped field
    });

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });
});

describe("POST /anchors/withdraw — request validation", () => {
  it("accepts a valid interactive withdrawal start", async () => {
    const res = await postAnchors("/anchors/withdraw", { assetCode: "XLM" });

    expect(res.statusCode).toBe(200);
  });

  it("rejects a missing asset code before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/withdraw", {});

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects a malformed Stellar destination before any anchor call", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/withdraw", {
      assetCode: "USDC",
      to: badKey,
    });

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
  });

  it("rejects an unexpected field instead of silently stripping it", async () => {
    const { anchorService } = await import("../src/services/anchor");
    const res = await postAnchors("/anchors/withdraw", {
      assetCode: "XLM",
      memo_typo: "text",
    });

    expectValidationError(res);
    expect(anchorService.getToml).not.toHaveBeenCalled();
    expect(prisma.anchorSession.create).not.toHaveBeenCalled();
  });
});

describe("POST /withdraw — request validation", () => {
  it("accepts a valid withdrawal request", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({ amount: "5", assetCode: "XLM" });

    expect(res.statusCode).toBe(200);
    expect(res.json().withdrawal.id).toBe("wth_1");
    expect(stellar.loadAccount).toHaveBeenCalled();
  });

  it("rejects a missing amount or asset code before touching Horizon", async () => {
    const { stellar } = await import("../src/services/stellar");

    const noAmount = await postWithdraw({ assetCode: "XLM" });
    expectValidationError(noAmount);

    const noAsset = await postWithdraw({ amount: "5" });
    expectValidationError(noAsset);

    expect(stellar.loadAccount).not.toHaveBeenCalled();
    expect(prisma.withdrawal.create).not.toHaveBeenCalled();
  });

  it("keeps the established INVALID_AMOUNT code for zero", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({ amount: "0", assetCode: "XLM" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INVALID_AMOUNT");
    expect(stellar.loadAccount).not.toHaveBeenCalled();
  });

  it("rejects a negative amount as a validation error before touching Horizon", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({ amount: "-5", assetCode: "XLM" });

    expectValidationError(res);
    expect(stellar.loadAccount).not.toHaveBeenCalled();
  });

  it("rejects an amount with excess precision before touching Horizon", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({
      amount: "1.00000008",
      assetCode: "XLM",
    });

    expectValidationError(res);
    expect(stellar.loadAccount).not.toHaveBeenCalled();
  });

  it("rejects a punctuated or empty asset code before touching Horizon", async () => {
    const { stellar } = await import("../src/services/stellar");

    const punctuated = await postWithdraw({ amount: "5", assetCode: "US-C" });
    expectValidationError(punctuated);

    const empty = await postWithdraw({ amount: "5", assetCode: "" });
    expectValidationError(empty);

    expect(stellar.loadAccount).not.toHaveBeenCalled();
  });

  it("keeps the established UNSUPPORTED_ASSET code for a well-formed but unsupported asset", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({ amount: "1", assetCode: "BTC" });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("UNSUPPORTED_ASSET");
    expect(stellar.loadAccount).not.toHaveBeenCalled();
  });

  it("rejects a memo that is not a Mergepay memo", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({
      amount: "5",
      assetCode: "XLM",
      memo: "not-a-mp-memo",
    });

    expectValidationError(res);
    expect(stellar.loadAccount).not.toHaveBeenCalled();
  });

  it("rejects an unexpected field instead of silently stripping it", async () => {
    const { stellar } = await import("../src/services/stellar");
    const res = await postWithdraw({
      amount: "5",
      assetCode: "XLM",
      memoTypo: "MP:ABC",
    });

    expectValidationError(res);
    expect(stellar.loadAccount).not.toHaveBeenCalled();
    expect(prisma.withdrawal.create).not.toHaveBeenCalled();
  });
});
