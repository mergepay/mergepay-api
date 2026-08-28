import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  INTENT_VALIDITY_SECONDS,
  MAX_INTENT_VALIDITY_SECONDS,
} from "../src/lib/time-bounds";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 1 })),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    findMany: vi.fn(async () => []),
  });
  const prisma: any = {
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    groupMember: model(),
    group: model(),
    user: model(),
    auditLog: model(),
    statusHistory: model(),
    idempotencyKey: model(),
  };
  prisma.$transaction = vi.fn(async (arg: any) =>
    typeof arg === "function" ? arg(prisma) : Promise.all(arg)
  );
  return {
    prisma,
    loadAccount: vi.fn(),
    buildPayment: vi.fn(),
    submitPayment: vi.fn(async () => "hash_abc"),
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));
vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: h.loadAccount,
      buildPayment: h.buildPayment,
      submitPayment: h.submitPayment,
    },
  };
});

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;
const prisma = h.prisma;

const USER_ID = "user_1";
const payerKeypair = Keypair.random();
const payeeKeypair = Keypair.random();
const PAYER_KEY = payerKeypair.publicKey();
const PAYEE_KEY = payeeKeypair.publicKey();

function authHeader(userId = USER_ID) {
  return {
    authorization: `Bearer ${signToken({ id: userId, stellarPublicKey: PAYER_KEY })}`,
  };
}

/**
 * Build a real unsigned payment XDR for use in buildPayment mocks.
 * Needed because the deposit/withdraw routes now compute txHash from the XDR.
 */
function makeRealUnsignedXdr(params: {
  source: string;
  destination: string;
  amount: string;
  memoCode?: string;
  validitySeconds?: number;
}): string {
  const source = new Account(params.source, "1");
  return new TransactionBuilder(source, {
    fee: String(Number(BASE_FEE) * 2),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination,
        asset: Asset.native(),
        amount: params.amount,
      })
    )
    .addMemo(Memo.text(params.memoCode ? `MP:${params.memoCode}` : "MP:TEST"))
    .setTimeout(params.validitySeconds ?? INTENT_VALIDITY_SECONDS)
    .build()
    .toXDR();
}

/**
 * Build a real signed payment envelope matching a settlement/treasury
 * intent, so confirm-route tests exercise the actual XDR validation path
 * instead of relying on it being bypassed.
 */
function signedXdrFor({
  destination = PAYEE_KEY,
  amount = "10",
  assetCode = "XLM",
  assetIssuer = null,
  memoCode = "ABC123",
  expiresAt,
}: {
  destination?: string;
  amount?: string;
  assetCode?: string;
  assetIssuer?: string | null;
  memoCode?: string;
  expiresAt?: Date | null;
} = {}) {
  const account = new Account(PAYER_KEY, "1");
  const maxTime = expiresAt
    ? Math.floor(expiresAt.getTime() / 1000)
    : Math.floor(Date.now() / 1000) + INTENT_VALIDITY_SECONDS;
  const tx = new TransactionBuilder(account, {
    fee: String(Number(BASE_FEE) * 2),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination,
        asset: assetIssuer ? new Asset(assetCode, assetIssuer) : Asset.native(),
        amount,
      })
    )
    .addMemo(Memo.text(`MP:${memoCode}`))
    .setTimebounds(0, maxTime)
    .build();
  tx.sign(payerKeypair);
  return tx.toXDR();
}

function fakeUser(id: string, key: string) {
  return {
    id,
    stellarPublicKey: key,
    displayName: "Tester",
    avatarUrl: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function fakeSettlement(over: Record<string, unknown> = {}) {
  return {
    id: "settle_1",
    shortCode: "ABC123",
    groupId: "group_1",
    fromUserId: USER_ID,
    toUserId: "user_2",
    amount: "10",
    assetCode: "XLM",
    assetIssuer: null,
    stellarTxHash: null,
    transactionXdr: null,
    status: "pending",
    retryCount: 0,
    failureReason: null,
    memo: "MP:ABC123",
    expenseId: null,
    expenseShareId: null,
    expiresAt: new Date(Date.now() + INTENT_VALIDITY_SECONDS * 1000),
    createdAt: new Date("2026-07-30T12:00:00Z"),
    updatedAt: new Date("2026-07-30T12:00:00Z"),
    from: fakeUser(USER_ID, PAYER_KEY),
    to: fakeUser("user_2", PAYEE_KEY),
    ...over,
  };
}

function fakeTreasuryTx(over: Record<string, unknown> = {}) {
  return {
    id: "ttx_1",
    shortCode: "TRE123",
    groupId: "group_1",
    userId: USER_ID,
    direction: "deposit",
    amount: "10",
    assetCode: "XLM",
    assetIssuer: null,
    destination: PAYEE_KEY,
    stellarTxHash: null,
    status: "pending",
    memo: "MP:TRE123",
    expiresAt: new Date(Date.now() + INTENT_VALIDITY_SECONDS * 1000),
    createdAt: new Date("2026-07-30T12:00:00Z"),
    user: fakeUser(USER_ID, PAYER_KEY),
    ...over,
  };
}

/** Well past the window and the whole skew tolerance. */
function longExpired() {
  return new Date(
    Date.now() - (INTENT_VALIDITY_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 600) * 1000
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
  h.loadAccount.mockResolvedValue({
    exists: true,
    sequence: "1",
    balances: [],
    signers: [],
    thresholds: { low: 0, med: 0, high: 0 },
  });
  h.buildPayment.mockImplementation((params: any) =>
    makeRealUnsignedXdr({
      source: params.sourcePublicKey ?? PAYER_KEY,
      destination: params.destination,
      amount: params.amount,
      memoCode: params.memoCode,
      validitySeconds: params.validitySeconds,
    })
  );
  h.submitPayment.mockResolvedValue("hash_abc");
  // Serves both the membership check and the recipient lookup (which includes
  // the user relation).
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: "group_1",
    userId: USER_ID,
    role: "admin",
    user: fakeUser("user_2", PAYEE_KEY),
  });
  prisma.settlement.updateMany.mockResolvedValue({ count: 1 });
  prisma.auditLog.create.mockResolvedValue({});
  prisma.idempotencyKey.findFirst.mockResolvedValue(null);
  prisma.idempotencyKey.create.mockResolvedValue({});
});

describe("creating an intent records a server-controlled expiry", () => {
  beforeEach(() => {
    prisma.settlement.create.mockImplementation(async ({ data }: any) =>
      fakeSettlement({ ...data, from: fakeUser(USER_ID, PAYER_KEY), to: fakeUser("user_2", PAYEE_KEY) })
    );
  });

  it("returns the deadline alongside the unsigned XDR", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: authHeader(),
      payload: { toUserId: "user_2", amount: "10", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.expiresAt).toBeTruthy();
    expect(body.expiresInSeconds).toBeGreaterThan(0);
    expect(body.expiresInSeconds).toBeLessThanOrEqual(INTENT_VALIDITY_SECONDS);
    expect(body.settlement.expiresAt).toBe(body.expiresAt);

    // Persisted, and never taken from the request.
    const created = prisma.settlement.create.mock.calls[0][0].data;
    expect(created.expiresAt).toBeInstanceOf(Date);
    expect(created.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("builds the envelope with the same window it recorded", async () => {
    await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: authHeader(),
      payload: { toUserId: "user_2", amount: "10", assetCode: "XLM", validitySeconds: 90 },
    });

    expect(h.buildPayment).toHaveBeenCalledWith(
      expect.objectContaining({ validitySeconds: 90 })
    );
    const created = prisma.settlement.create.mock.calls[0][0].data;
    expect(created.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(90_000);
  });

  it("rejects an unreasonable requested window before any Stellar work", async () => {
    for (const validitySeconds of [0, -1, MAX_INTENT_VALIDITY_SECONDS + 1, 86_400]) {
      const res = await app.inject({
        method: "POST",
        url: "/groups/group_1/settlements",
        headers: authHeader(),
        payload: { toUserId: "user_2", amount: "10", assetCode: "XLM", validitySeconds },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("VALIDATION_ERROR");
    }
    expect(h.buildPayment).not.toHaveBeenCalled();
    expect(h.loadAccount).not.toHaveBeenCalled();
  });

  it("ignores a client-supplied absolute deadline entirely", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: authHeader(),
      payload: {
        toUserId: "user_2",
        amount: "10",
        assetCode: "XLM",
        // Not part of the schema — a client cannot set the deadline directly.
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    expect(res.statusCode).toBe(200);
    const created = prisma.settlement.create.mock.calls[0][0].data;
    expect(created.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + INTENT_VALIDITY_SECONDS * 1000
    );
  });

  it("records an expiry on treasury intents too", async () => {
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: PAYEE_KEY,
      treasuryRequiredSigners: 1,
    });
    prisma.treasuryTransaction.create.mockImplementation(async ({ data }: any) =>
      fakeTreasuryTx({ ...data, user: fakeUser(USER_ID, PAYER_KEY) })
    );

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/treasury/deposit",
      headers: authHeader(),
      payload: { amount: "10", assetCode: "XLM" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().expiresAt).toBeTruthy();
    expect(res.json().treasuryTransaction.expiresAt).toBeTruthy();
    expect(
      prisma.treasuryTransaction.create.mock.calls[0][0].data.expiresAt
    ).toBeInstanceOf(Date);
    expect(h.buildPayment).toHaveBeenCalledWith(
      expect.objectContaining({ validitySeconds: INTENT_VALIDITY_SECONDS })
    );
  });
});

describe("settlement confirm rejects an expired intent", () => {
  it("accepts a confirm inside the window", async () => {
    const settlement = fakeSettlement();
    prisma.settlement.findUnique.mockResolvedValue(settlement);
    prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      ...settlement,
      status: "submitted",
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: signedXdrFor({ expiresAt: settlement.expiresAt }) },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
  });

  it("rejects a stale intent with the stable expiration error", async () => {
    const expiresAt = longExpired();
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ expiresAt })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: signedXdrFor({ expiresAt }) },
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe("INTENT_EXPIRED");
    expect(body.message).toMatch(/expired/i);
    expect(body.details.clockSkewToleranceSeconds).toBe(CLOCK_SKEW_TOLERANCE_SECONDS);
  });

  it("never stores the envelope or submits it when the intent has expired", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ expiresAt: longExpired() })
    );

    await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: "signed-xdr-abc" },
    });

    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
    expect(h.submitPayment).not.toHaveBeenCalled();
  });

  it("accepts a confirm arriving within the clock-skew tolerance", async () => {
    const nearExpiry = new Date(Date.now() - (CLOCK_SKEW_TOLERANCE_SECONDS - 5) * 1000);
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ expiresAt: nearExpiry })
    );
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: signedXdrFor({ expiresAt: nearExpiry }) },
    });

    expect(res.statusCode).toBe(200);
  });

  it("reports ownership before expiry, so a stranger learns nothing from the difference", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ fromUserId: "someone_else", expiresAt: longExpired() })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: "signed-xdr-abc" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("FORBIDDEN");
  });

  it("distinguishes a missing settlement from an expired one", async () => {
    prisma.settlement.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: "signed-xdr-abc" },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("NOT_FOUND");
  });

  it("treats an intent with no recorded deadline as still valid", async () => {
    const settlement = fakeSettlement({ expiresAt: null });
    prisma.settlement.findUnique.mockResolvedValue(settlement);
    prisma.settlement.findUniqueOrThrow.mockResolvedValue({
      ...settlement,
      status: "submitted",
    });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "intent-expiration-confirm" },
      payload: { signedXdr: signedXdrFor() },
    });

    expect(res.statusCode).toBe(200);
  });
});

describe("treasury confirm rejects an expired intent", () => {
  beforeEach(() => {
    prisma.group.findUnique.mockResolvedValue({
      id: "group_1",
      treasuryEnabled: true,
      treasuryAccountPublicKey: PAYEE_KEY,
      treasuryRequiredSigners: 1,
    });
  });

  it("submits a confirm inside the window, passing the intent through", async () => {
    prisma.treasuryTransaction.findUnique.mockResolvedValue(fakeTreasuryTx());
    prisma.treasuryTransaction.update.mockResolvedValue(
      fakeTreasuryTx({ status: "confirmed", stellarTxHash: "hash_abc" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "signed-xdr-abc" },
    });

    expect(res.statusCode).toBe(200);
    // The submission carries the recorded expiry, so the service re-validates
    // the envelope's own time bounds against it.
    expect(h.submitPayment).toHaveBeenCalledWith(
      "signed-xdr-abc",
      expect.objectContaining({
        expiresAt: expect.any(Date),
        resource: "treasury transaction",
      })
    );
  });

  it("never submits to Horizon once the intent has expired", async () => {
    prisma.treasuryTransaction.findUnique.mockResolvedValue(
      fakeTreasuryTx({ expiresAt: longExpired() })
    );

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "signed-xdr-abc" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INTENT_EXPIRED");
    expect(h.submitPayment).not.toHaveBeenCalled();
    expect(prisma.treasuryTransaction.update).not.toHaveBeenCalled();
  });

  it("applies the same rule to a multisig withdrawal awaiting signatures", async () => {
    prisma.treasuryTransaction.findUnique.mockResolvedValue(
      fakeTreasuryTx({
        direction: "withdrawal",
        status: "awaiting_signatures",
        expiresAt: longExpired(),
      })
    );

    const res = await app.inject({
      method: "POST",
      url: "/treasury-transactions/ttx_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "signed-xdr-abc" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("INTENT_EXPIRED");
    expect(h.submitPayment).not.toHaveBeenCalled();
  });
});
