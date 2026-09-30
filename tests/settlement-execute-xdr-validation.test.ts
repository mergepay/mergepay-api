/**
 * POST /api/settlements/execute — XDR intent validation at the route boundary
 * (#701).
 *
 * The route's idempotency tests mock `validateSettlementXdr`, which is right
 * for their purpose. These tests do the opposite: they hand the route *real*
 * Stellar envelopes, built and signed locally the way a wallet would, and
 * assert that tampered ones — different destination, amount, asset, memo,
 * source, or signature — are rejected before anything is persisted, while the
 * envelope matching the recorded intent is accepted. The API never sees a
 * private key: only the wallet-held keypair signs, and only the envelope
 * reaches the server.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Memo,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
    deleteMany: vi.fn(async () => ({ count: 0 })),
  });
  const prisma: any = {
    settlement: model(),
    groupMember: model(),
    idempotencyKey: model(),
    statusHistory: model(),
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("@prisma/client", async (importActual) => {
  const actual = await importActual<any>();
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      PrismaClientKnownRequestError: class extends Error {
        code: string;
        constructor(message: string, code: string) {
          super(message);
          this.code = code;
        }
      },
    },
  };
});

vi.mock("../src/services/status-history", () => ({
  recordStatusTransitionInTransaction: vi.fn(async () => undefined),
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { config } from "../src/config";

const prisma = h.prisma;
let app: Awaited<ReturnType<typeof buildApp>>;

const USER_ID = "user_1";
const GROUP_ID = "group_1";
const SETTLEMENT_ID = "settlement_1";
const SHORT_CODE = "AB12CD";

/** The sharer who pays the payer back — the settlement's `from`. */
const walletKeypair = Keypair.random();
/** The payer — the settlement's `to` (destination). */
const payerKeypair = Keypair.random();

function authHeader() {
  const token = signToken({
    id: USER_ID,
    stellarPublicKey: walletKeypair.publicKey(),
  });
  return { authorization: `Bearer ${token}` };
}

const user = (id: string, kp: Keypair) => ({
  id,
  stellarPublicKey: kp.publicKey(),
  displayName: id,
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

/** The recorded intent: what the API built and the wallet agreed to sign. */
const intent = {
  shortCode: SHORT_CODE,
  amount: "10.0000000",
  assetCode: "XLM",
  assetIssuer: null,
  expiresAt: null,
  from: { stellarPublicKey: walletKeypair.publicKey() },
  to: { stellarPublicKey: payerKeypair.publicKey() },
};

function settlementRow() {
  return {
    id: SETTLEMENT_ID,
    shortCode: SHORT_CODE,
    groupId: GROUP_ID,
    fromUserId: USER_ID,
    toUserId: "payer_1",
    amount: intent.amount,
    assetCode: "XLM",
    assetIssuer: null,
    status: "pending",
    transactionXdr: null,
    stellarTxHash: null,
    memo: `MP:${SHORT_CODE}`,
    retryCount: 0,
    failureReason: null,
    expiresAt: null,
    submittedAt: null,
    confirmedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    from: user(USER_ID, walletKeypair),
    to: user("payer_1", payerKeypair),
    statusHistory: [],
  };
}

let current: ReturnType<typeof settlementRow>;

/** Each test gets its own client address so rate-limit budgets never bleed. */
let clientAddress = 0;

function execute(signedXdr: string, key = "key-execute-1") {
  clientAddress += 1;
  return app.inject({
    method: "POST",
    url: "/api/settlements/execute",
    headers: {
      ...authHeader(),
      "x-idempotency-key": key,
    },
    payload: { settlementId: SETTLEMENT_ID, signedXdr },
    remoteAddress: `10.2.${Math.floor(clientAddress / 256)}.${clientAddress % 256}`,
  });
}

/**
 * Build a payment envelope whose fields default to the recorded intent.
 * Every tamper test changes exactly one field.
 */
function buildPayment({
  source = intent.from.stellarPublicKey,
  destination = intent.to.stellarPublicKey,
  amount = intent.amount,
  asset = Asset.native(),
  memo = `MP:${SHORT_CODE}`,
  timeout = 300,
}: {
  source?: string;
  destination?: string;
  amount?: string;
  asset?: Asset;
  memo?: string;
  timeout?: number;
} = {}): string {
  return new TransactionBuilder(new Account(source, "12345"), {
    fee: String(Number(BASE_FEE) * 2),
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.payment({ destination, asset, amount }))
    .addMemo(Memo.text(memo))
    .setTimeout(timeout)
    .build()
    .toXDR();
}

/** Sign the way a wallet would: locally, with a key the API never sees. */
function sign(xdr: string, signer: Keypair = walletKeypair): string {
  const tx = new Transaction(xdr, config.networkPassphrase);
  tx.sign(signer);
  return tx.toXDR();
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();

  current = settlementRow();
  prisma.settlement.findUnique.mockImplementation(async () => current);
  prisma.settlement.findUniqueOrThrow.mockImplementation(async () => current);
  prisma.settlement.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!where.status?.in?.includes(current.status)) return { count: 0 };
    current = { ...current, ...data };
    return { count: 1 };
  });
  prisma.groupMember.findUnique.mockResolvedValue({
    groupId: GROUP_ID,
    userId: USER_ID,
    role: "member",
  });
  prisma.auditLog.create.mockResolvedValue({ id: "audit_1" });
});

describe("POST /api/settlements/execute — XDR intent validation", () => {
  it("accepts the signed envelope that matches the recorded intent", async () => {
    const res = await execute(sign(buildPayment()), "key-valid");

    expect(res.statusCode).toBe(202);
    expect(res.json().settlement.status).toBe("submitted");
    // The accepted envelope is the one persisted for the worker.
    expect(prisma.settlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ transactionXdr: expect.stringMatching(/^AAAA/) }),
      })
    );
  });

  it("rejects an envelope paying a different destination than the intent, without persisting it", async () => {
    const tampered = sign(
      buildPayment({ destination: Keypair.random().publicKey() })
    );

    const res = await execute(tampered, "key-dest");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/destination/i);
    expect(current.transactionXdr).toBeNull();
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "settlement.execute.validation_failed",
        }),
      })
    );
  });

  it("rejects an envelope carrying a different amount than the intent", async () => {
    const res = await execute(sign(buildPayment({ amount: "99.0000000" })), "key-amount");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/amount/i);
  });

  it("rejects an envelope whose asset was swapped", async () => {
    const res = await execute(
      sign(
        buildPayment({
          asset: new Asset(config.STABLE_ASSET_CODE, config.STABLE_ASSET_ISSUER!),
        })
      ),
      "key-asset"
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/asset/i);
  });

  it("rejects an envelope whose memo no longer references this settlement", async () => {
    const res = await execute(
      sign(buildPayment({ memo: "MP:ZZ9999" })),
      "key-memo"
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/memo/i);
  });

  it("rejects an envelope whose source is not the settlement's payer", async () => {
    const impostor = Keypair.random();
    const res = await execute(
      sign(buildPayment({ source: impostor.publicKey() }), impostor),
      "key-source"
    );

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/source/i);
  });

  it("rejects an envelope signed by someone other than the settlement payer", async () => {
    const res = await execute(sign(buildPayment(), Keypair.random()), "key-signer");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/signature/i);
  });

  it("rejects an unsigned envelope", async () => {
    const res = await execute(buildPayment(), "key-unsigned");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/signature/i);
  });

  it("rejects malformed XDR without touching the database", async () => {
    const res = await execute("not-a-real-xdr-envelope", "key-malformed");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MALFORMED");
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a fee-bump wrapper", async () => {
    const inner = new Transaction(sign(buildPayment()), config.networkPassphrase);
    const feeBump = TransactionBuilder.buildFeeBumpTransaction(
      walletKeypair,
      String(Number(BASE_FEE) * 10),
      inner,
      config.networkPassphrase
    ).toXDR();

    const res = await execute(feeBump, "key-feebump");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/fee-bump/i);
  });

  it("rejects an envelope whose validity window outlives the recorded intent expiry", async () => {
    // The intent expires in 10s but the envelope is valid for 300s — a wallet
    // may not extend the deadline the server chose.
    const expiresAt = new Date(Date.now() + 10_000);
    current = { ...current, expiresAt };

    const res = await execute(sign(buildPayment({ timeout: 300 })), "key-window");

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("XDR_MISMATCH");
    expect(res.json().message).toMatch(/valid longer|time bound/i);
  });

  it("never echoes the envelope back in the error response", async () => {
    const envelope = sign(buildPayment({ amount: "99.0000000" }));

    const res = await execute(envelope, "key-echo");

    expect(res.body).not.toContain(envelope);
    expect(res.body).not.toMatch(/AAAA/);
  });

  it("audits the validation failure for later review", async () => {
    await execute(sign(buildPayment({ amount: "99.0000000" })), "key-audit");

    const auditCalls = prisma.auditLog.create.mock.calls as Array<
      [{ data: { action: string; userId: string; groupId: string; entityId: string; metadata: { reason: string } } }]
    >;
    const failure = auditCalls.find(
      (call) => call[0]?.data?.action === "settlement.execute.validation_failed"
    );
    expect(failure).toBeDefined();
    const data = failure![0].data;
    expect(data).toBeDefined();
    expect(data.userId).toBe(USER_ID);
    expect(data.groupId).toBe(GROUP_ID);
    expect(data.entityId).toBe(SETTLEMENT_ID);
    // The stable reason text only, never the envelope.
    expect(data.metadata.reason).toMatch(/amount/i);
    expect(JSON.stringify(data)).not.toMatch(/AAAA/);
  });
});
