import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  });
  const prisma: any = {
    idempotencyKey: model(),
    settlement: model(),
    auditLog: { create: vi.fn() },
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
    loadAccount: vi.fn(async () => ({
      exists: true,
      sequence: "1",
      balances: [],
      signers: [],
      thresholds: { low: 0, med: 0, high: 0 },
    })),
    buildPayment: vi.fn(() => "unsigned-xdr"),
    submitPayment: vi.fn(),
  },
  memoText: vi.fn((code: string) => `MP:${code}`),
  validateSignedXdr: vi.fn((_signedXdr: string, _expected: any) => ({
    tx: {} as any,
    hash: "abc123def456",
  })),
}));

const idem = vi.hoisted(() => ({
  claim: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));

vi.mock("../src/services/idempotency", () => ({
  claimIdempotencyKey: idem.claim,
  completeIdempotencyKey: idem.complete,
  failIdempotencyKey: idem.fail,
}));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";

const prisma = h.prisma;

const fakeUser = (over: Record<string, any> = {}) => ({
  id: "user_1",
  stellarPublicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  displayName: "Tester",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

const fakeRecipient = () => ({
  id: "user_2",
  stellarPublicKey: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  displayName: "Recipient",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

const fakeSettlement = (over: Record<string, any> = {}) => ({
  id: "settle_1",
  groupId: "group_1",
  shortCode: "ABC123",
  fromUserId: "user_1",
  toUserId: "user_2",
  amount: "10.00",
  assetCode: "USDC",
  assetIssuer: "GABCDEF...",
  status: "pending",
  transactionXdr: null,
  retryCount: 0,
  memo: "MP:ABC123",
  expenseId: null,
  expenseShareId: null,
  stellarTxHash: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  from: fakeUser(),
  to: fakeRecipient(),
  ...over,
});

function authHeader(user = fakeUser()) {
  const token = signToken({ id: user.id, stellarPublicKey: user.stellarPublicKey });
  return { authorization: `Bearer ${token}` };
}

function expectedHash(settlement: ReturnType<typeof fakeSettlement>, signedXdr: string): string {
  return crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        settlementId: settlement.id,
        amount: settlement.amount.toString(),
        assetCode: settlement.assetCode,
        assetIssuer: settlement.assetIssuer,
        fromUserId: settlement.fromUserId,
        toUserId: settlement.toUserId,
        memo: settlement.memo,
        signedXdr,
      })
    )
    .digest("hex");
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  idem.claim.mockResolvedValue({ outcome: "claimed", id: "idem_1" });
  if (!app) app = await buildApp();
});

describe("idempotency — confirm endpoint", () => {
  const signedXdr = "AAAA...";

  it("claims the key, runs the mutation, then marks it completed", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: signedXdr })
    );
    prisma.auditLog.create.mockResolvedValue({});
    const { stellar } = await import("../src/services/stellar");

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.settlement.status).toBe("submitted");

    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: {
        userId: "user_1",
        scope: "settlement.confirm",
        key: "key-001",
        userId: "user_1",
        status: "in_progress",
      }),
    });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: "key-001" },
      data: expect.objectContaining({ status: "completed", statusCode: 200 }),
    });
    // The worker handles Stellar submission; confirm endpoint only stores the XDR.
    expect(stellar.submitPayment).not.toHaveBeenCalled();
  });

  it("repeat confirm with same key + same body returns the cached response without re-running", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.update.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: "AAAA..." })
    );
    prisma.auditLog.create.mockResolvedValue({});

    const first = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr: "AAAA..." },
    });
    expect(first.statusCode).toBe(200);
    const stored = prisma.idempotencyKey.create.mock.calls[0][0].data;

    vi.clearAllMocks();
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      ...stored,
      responseJson: JSON.stringify({
        settlement: { id: "settle_1", status: "submitted", transactionXdr: "AAAA..." },
      }),
    });

    const second = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr: "AAAA..." },
    });

    expect(second.statusCode).toBe(200);
    expect(second.json().settlement.status).toBe("submitted");
    // The pre-validation read happens before the idempotent block; the
    // operation itself is never re-run because the key is cached.
    expect(prisma.settlement.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();

    const { stellar } = await import("../src/services/stellar");
    expect(stellar.submitPayment).not.toHaveBeenCalled();
  });

  it("same key + different body returns 409 idempotency conflict", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "user_1",
      scope: "settlement.confirm",
      key: "key-001",
      requestHash: "some-other-hash-entirely",
      responseJson: JSON.stringify({ settlement: { status: "submitted" } }),
      expiresAt: new Date(Date.now() + 60_000),
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("IDEMPOTENCY_CONFLICT");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("returns 409 IDEMPOTENCY_IN_PROGRESS for a concurrent request under the same key", async () => {
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    idem.claim.mockResolvedValueOnce({ outcome: "in_progress" });

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "key-001" },
      payload: { signedXdr: "BBBBB..." },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("IDEMPOTENCY_CONFLICT");
    // The pre-validation read happens before the conflict is detected.
    expect(prisma.settlement.findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized or malformed Idempotency-Key header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "has spaces / slashes" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INVALID_IDEMPOTENCY_KEY");
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
  });

  it("requires an Idempotency-Key header", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "CCCCC..." },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("MISSING_IDEMPOTENCY_KEY");
  });

  it("does not clobber a settlement a concurrent confirm already transitioned", async () => {
    // Two confirms both read status "pending", but only the guarded
    // updateMany(WHERE status IN ['pending','failed']) actually matches for the winner.
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: "WINNER..." })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-2" },
      payload: { signedXdr: "LOSER..." },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().settlement.status).toBe("submitted");
    expect(prisma.settlement.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects confirmation from a user who does not own the settlement", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ fromUserId: "someone_else" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: { ...authHeader(), "idempotency-key": "confirm-key-1" },
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.settlement.update).not.toHaveBeenCalled();
  });

  it("does not clobber a settlement a concurrent confirm already transitioned", async () => {
    // Two confirms both read status "pending", but only the guarded
    // updateMany(WHERE status = 'pending') actually matches for the winner.
    prisma.settlement.findUnique.mockResolvedValue(fakeSettlement());
    prisma.settlement.updateMany.mockResolvedValue({ count: 0 });
    prisma.settlement.findUniqueOrThrow.mockResolvedValue(
      fakeSettlement({ status: "submitted", transactionXdr: "WINNER..." })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr: "LOSER..." },
    });

    expect(res.statusCode).toBe(200);
    // The winner's status is returned; our own "LOSER..." XDR never applied
    // (the guarded updateMany matched zero rows), and we never re-audit a
    // transition we didn't actually make.
    expect(res.json().settlement.status).toBe("submitted");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("rejects confirmation from a user who does not own the settlement", async () => {
    prisma.settlement.findUnique.mockResolvedValue(
      fakeSettlement({ fromUserId: "someone_else" })
    );

    const res = await app.inject({
      method: "POST",
      url: "/settlements/settle_1/confirm",
      headers: authHeader(),
      payload: { signedXdr },
    });

    expect(res.statusCode).toBe(403);
    expect(prisma.settlement.updateMany).not.toHaveBeenCalled();
  });

  it("a failed claim (e.g. settlement not found) frees the key so a corrected retry can proceed", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});
    prisma.settlement.findUnique.mockResolvedValue(null);

    const res = await app.inject({
      method: "POST",
      url: "/settlements/missing/confirm",
      headers: {
        ...authHeader(),
        "idempotency-key": "key-002",
      },
      payload: { signedXdr: "AAAA..." },
    });

    expect(res.statusCode).toBe(404);
    expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: "key-002" } });
    expect(prisma.idempotencyKey.update).not.toHaveBeenCalled();
  });
});

describe("idempotency — settlement creation", () => {
  it("repeating an identical create request returns the original settlement without creating another", async () => {
    const { hashIdempotentRequest } = await import("../src/lib/idempotency");
    const body = { toUserId: "user_2", amount: "10", assetCode: "XLM", assetIssuer: null };
    const requestHash = hashIdempotentRequest({
      userId: "user_1",
      scope: "settlement.create.group:group_1",
      body,
    });
    const storedResponse = {
      settlement: fakeSettlement({ assetCode: "XLM", assetIssuer: null, amount: "10" }),
      xdr: "unsigned-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    };
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: "create-key-1",
      userId: "user_1",
      requestHash,
      status: "completed",
      statusCode: 200,
      responseJson: JSON.stringify(storedResponse),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: { ...authHeader(), "idempotency-key": "create-key-1" },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.groupMember.findUnique).not.toHaveBeenCalled();
    expect(prisma.settlement.create).not.toHaveBeenCalled();
  });

  it("reusing a create key with a different intent (amount) is rejected", async () => {
    const { hashIdempotentRequest } = await import("../src/lib/idempotency");
    const originalBody = { toUserId: "user_2", amount: "10", assetCode: "XLM", assetIssuer: null };
    const requestHash = hashIdempotentRequest({
      userId: "user_1",
      scope: "settlement.create.group:group_1",
      body: originalBody,
    });
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: "create-key-1",
      userId: "user_1",
      requestHash,
      status: "completed",
      statusCode: 200,
      responseJson: JSON.stringify({ settlement: fakeSettlement() }),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: { ...authHeader(), "idempotency-key": "create-key-1" },
      payload: { toUserId: "user_2", amount: "999", assetCode: "XLM", assetIssuer: null },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("idempotency_conflict");
    expect(prisma.settlement.create).not.toHaveBeenCalled();
  });

  it("a losing claim in a concurrent create race replays instead of double-creating", async () => {
    const { hashIdempotentRequest } = await import("../src/lib/idempotency");
    const body = { toUserId: "user_2", amount: "10", assetCode: "XLM", assetIssuer: null };
    const requestHash = hashIdempotentRequest({
      userId: "user_1",
      scope: "settlement.create.group:group_1",
      body,
    });

    // First lookup (pre-create): no row yet — this request looks like the winner.
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    // The create loses the race — Prisma's unique-constraint violation code.
    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prisma.idempotencyKey.create.mockRejectedValueOnce(conflict);
    // Post-race lookup finds the winner's now-completed row.
    const winnerResponse = {
      settlement: fakeSettlement({ assetCode: "XLM", assetIssuer: null, amount: "10" }),
      xdr: "unsigned-xdr",
      networkPassphrase: "Test SDF Network ; September 2015",
    };
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      key: "race-key",
      userId: "user_1",
      requestHash,
      status: "completed",
      statusCode: 200,
      responseJson: JSON.stringify(winnerResponse),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const res = await app.inject({
      method: "POST",
      url: "/groups/group_1/settlements",
      headers: { ...authHeader(), "idempotency-key": "race-key" },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(prisma.settlement.create).not.toHaveBeenCalled();
  });
});
