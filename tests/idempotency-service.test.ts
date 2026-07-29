import { describe, it, expect, beforeEach, vi } from "vitest";
import { Prisma } from "@prisma/client";

const h = vi.hoisted(() => ({
  prisma: {
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { runIdempotent, readIdempotencyKey, hashRequest } from "../src/services/idempotency";

const prisma = h.prisma;

function uniqueViolation() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "5.22.0",
  });
}

// Real prisma.$transaction just invokes the callback with a transaction
// client; here that's the same mocked prisma object, so tx.idempotencyKey
// resolves to the mocks configured on `prisma` above.
function realTransactionBehavior(fn: any) {
  return fn(prisma);
}

beforeEach(() => {
  vi.clearAllMocks();
  prisma.$transaction.mockImplementation(realTransactionBehavior);
  prisma.idempotencyKey.create.mockResolvedValue({});
});

describe("readIdempotencyKey", () => {
  it("returns null when no header is present", () => {
    expect(readIdempotencyKey({})).toBeNull();
  });

  it("accepts a well-formed key", () => {
    expect(readIdempotencyKey({ "idempotency-key": "abc-123_XYZ.9:foo" })).toBe(
      "abc-123_XYZ.9:foo"
    );
  });

  it("rejects an empty key", () => {
    expect(() => readIdempotencyKey({ "idempotency-key": "" })).toThrow();
  });

  it("rejects a key over 255 characters", () => {
    expect(() => readIdempotencyKey({ "idempotency-key": "a".repeat(256) })).toThrow();
  });

  it("rejects a key with disallowed characters", () => {
    expect(() => readIdempotencyKey({ "idempotency-key": "has spaces" })).toThrow();
  });
});

describe("runIdempotent", () => {
  it("runs the operation directly when no key is supplied", async () => {
    const operation = vi.fn(async () => "result");

    const result = await runIdempotent({
      userId: "user_1",
      scope: "settlement.confirm",
      key: null,
      resourceId: "settle_1",
      payload: {},
      operation,
    });

    expect(result).toBe("result");
    expect(operation).toHaveBeenCalledTimes(1);
    expect(prisma.idempotencyKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("returns a cached response for a repeated key with the same payload, without re-running", async () => {
    const payload = { amount: "10" };
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);
    const operation = vi.fn(async () => ({ ok: true }));

    await runIdempotent({
      userId: "user_1",
      scope: "settlement.create",
      key: "key-1",
      resourceId: "res_1",
      payload,
      operation,
    });
    expect(operation).toHaveBeenCalledTimes(1);
    const stored = prisma.idempotencyKey.create.mock.calls[0][0].data;

    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      ...stored,
      responseJson: JSON.stringify({ ok: true, cached: true }),
    });

    const second = await runIdempotent({
      userId: "user_1",
      scope: "settlement.create",
      key: "key-1",
      resourceId: "res_1",
      payload,
      operation,
    });

    expect(second).toEqual({ ok: true, cached: true });
    expect(operation).toHaveBeenCalledTimes(1); // not called again
  });

  it("throws a conflict when the same key is reused with a different payload", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "user_1",
      scope: "settlement.create",
      key: "key-1",
      requestHash: "some-hash-for-a-different-payload",
      responseJson: JSON.stringify({ ok: true }),
    });
    const operation = vi.fn();

    await expect(
      runIdempotent({
        userId: "user_1",
        scope: "settlement.create",
        key: "key-1",
        resourceId: "res_1",
        payload: { amount: "999" },
        operation,
      })
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("resolves to the winner's cached response when a concurrent request wins the insert race", async () => {
    const scope = "settlement.create" as const;
    const resourceId = "res_1";
    const payload = { amount: "10" };
    const sharedHash = hashRequest(scope, resourceId, payload);

    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null) // no record yet when we check
      .mockResolvedValueOnce({
        // winner's committed record, found after our insert loses. Same
        // scope/resourceId/payload as this request, so the hash matches.
        userId: "user_1",
        scope,
        key: "key-race",
        requestHash: sharedHash,
        responseJson: JSON.stringify({ settlementId: "winner_settlement" }),
      });
    // Our own attempt's final idempotency insert loses the race.
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueViolation());

    const operation = vi.fn(async () => ({ settlementId: "loser_settlement" }));

    const result = await runIdempotent({
      userId: "user_1",
      scope,
      key: "key-race",
      resourceId,
      payload,
      operation,
    });

    // The loser's operation did run (its side effects would be rolled back
    // with the real transaction in production), but the caller only ever
    // sees the winner's result — never its own, and never a duplicate.
    expect(operation).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ settlementId: "winner_settlement" });
  });

  it("returns a conflict if the concurrent winner's payload actually differed", async () => {
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        userId: "user_1",
        scope: "settlement.create",
        key: "key-race",
        requestHash: "a-hash-for-some-other-payload",
        responseJson: JSON.stringify({ settlementId: "winner_settlement" }),
      });
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueViolation());
    const operation = vi.fn(async () => ({ settlementId: "loser_settlement" }));

    await expect(
      runIdempotent({
        userId: "user_1",
        scope: "settlement.create",
        key: "key-race",
        resourceId: "res_1",
        payload: { amount: "10" },
        operation,
      })
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("propagates a non-unique-constraint error from the transaction unchanged", async () => {
    const boom = new Error("connection lost");
    const operation = vi.fn(async () => {
      throw boom;
    });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null);

    await expect(
      runIdempotent({
        userId: "user_1",
        scope: "settlement.create",
        key: "key-err",
        resourceId: "res_1",
        payload: {},
        operation,
      })
    ).rejects.toBe(boom);
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });
});
