import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    idempotencyKey: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
  cleanupExpiredIdempotencyKeys,
  hashIdempotentRequest,
} from "../src/lib/idempotency";

const prisma = h.prisma;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("hashIdempotentRequest", () => {
  it("is deterministic for identical inputs", () => {
    const a = hashIdempotentRequest({ userId: "u1", scope: "s", body: { amount: "10" } });
    const b = hashIdempotentRequest({ userId: "u1", scope: "s", body: { amount: "10" } });
    expect(a).toBe(b);
  });

  it("differs when the user, scope, or body differs", () => {
    const base = hashIdempotentRequest({ userId: "u1", scope: "s", body: { amount: "10" } });
    expect(hashIdempotentRequest({ userId: "u2", scope: "s", body: { amount: "10" } })).not.toBe(base);
    expect(hashIdempotentRequest({ userId: "u1", scope: "s2", body: { amount: "10" } })).not.toBe(base);
    expect(hashIdempotentRequest({ userId: "u1", scope: "s", body: { amount: "11" } })).not.toBe(base);
  });
});

describe("claimIdempotencyKey", () => {
  it("proceeds and creates a row when no key exists yet", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockResolvedValue({});

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });

    expect(outcome).toEqual({ kind: "proceed" });
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: "k1",
        userId: "u1",
        requestHash: "h1",
        status: "in_progress",
      }),
    });
  });

  it("replays a completed row for the same user + request hash", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "u1",
      requestHash: "h1",
      status: "completed",
      statusCode: 201,
      responseJson: JSON.stringify({ ok: true }),
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });

    expect(outcome).toEqual({ kind: "replay", statusCode: 201, body: { ok: true } });
    expect(prisma.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it("reports in_progress for a claim still being processed", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "u1",
      requestHash: "h1",
      status: "in_progress",
      statusCode: null,
      responseJson: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });
    expect(outcome).toEqual({ kind: "in_progress" });
  });

  it("reports conflict when the same key is reused by a different user", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "someone-else",
      requestHash: "h1",
      status: "completed",
      statusCode: 200,
      responseJson: "{}",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });
    expect(outcome).toEqual({ kind: "conflict" });
  });

  it("reports conflict when the same key is reused with a different request hash", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "u1",
      requestHash: "different-hash",
      status: "completed",
      statusCode: 200,
      responseJson: "{}",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });
    expect(outcome).toEqual({ kind: "conflict" });
  });

  it("treats an expired row as free and reclaims it", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      userId: "someone-else",
      requestHash: "stale-hash",
      status: "completed",
      statusCode: 200,
      responseJson: "{}",
      expiresAt: new Date(Date.now() - 1_000), // already expired
    });
    prisma.idempotencyKey.delete.mockResolvedValue({});
    prisma.idempotencyKey.create.mockResolvedValue({});

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });

    expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: "k1" } });
    expect(outcome).toEqual({ kind: "proceed" });
  });

  it("resolves a losing create race by reading the winner's row", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(null); // looked free at first
    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    prisma.idempotencyKey.create.mockRejectedValue(conflict);
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      userId: "u1",
      requestHash: "h1",
      status: "in_progress",
      statusCode: null,
      responseJson: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const outcome = await claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" });
    expect(outcome).toEqual({ kind: "in_progress" });
  });

  it("propagates a non-unique-constraint error from create", async () => {
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    prisma.idempotencyKey.create.mockRejectedValue(new Error("connection lost"));

    await expect(
      claimIdempotencyKey({ key: "k1", userId: "u1", requestHash: "h1" })
    ).rejects.toThrow("connection lost");
  });
});

describe("completeIdempotencyKey / failIdempotencyKey", () => {
  it("marks a claim completed with its status code and response", async () => {
    await completeIdempotencyKey("k1", 201, { ok: true });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { key: "k1" },
      data: { status: "completed", statusCode: 201, responseJson: JSON.stringify({ ok: true }) },
    });
  });

  it("deletes a claim on failure so a corrected retry can proceed", async () => {
    await failIdempotencyKey("k1");
    expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({ where: { key: "k1" } });
  });
});

describe("cleanupExpiredIdempotencyKeys", () => {
  it("deletes rows past their retention window and returns the count", async () => {
    prisma.idempotencyKey.deleteMany.mockResolvedValue({ count: 3 });
    const removed = await cleanupExpiredIdempotencyKeys();
    expect(removed).toBe(3);
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lt: expect.any(Date) } },
    });
  });
});
