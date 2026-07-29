import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    idempotencyKey: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  failIdempotencyKey,
} from "../src/services/idempotency";

const prisma = h.prisma;

function uniqueConstraintError(): Error {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimIdempotencyKey", () => {
  it("claims the key when no prior record exists", async () => {
    prisma.idempotencyKey.create.mockResolvedValueOnce({ id: "idem_1" });

    const result = await claimIdempotencyKey("user_1", "key-1", "hash-a");

    expect(result).toEqual({ outcome: "claimed", id: "idem_1" });
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: { userId: "user_1", key: "key-1", requestHash: "hash-a", status: "in_progress" },
    });
  });

  it("returns the stored response for a completed attempt with a matching fingerprint", async () => {
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      id: "idem_1",
      userId: "user_1",
      key: "key-1",
      requestHash: "hash-a",
      status: "succeeded",
      responseJson: '{"ok":true}',
    });

    const result = await claimIdempotencyKey("user_1", "key-1", "hash-a");

    expect(result).toEqual({ outcome: "completed", responseJson: '{"ok":true}' });
  });

  it("reports a conflict when the key was used for a different request fingerprint", async () => {
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      id: "idem_1",
      userId: "user_1",
      key: "key-1",
      requestHash: "hash-a",
      status: "succeeded",
      responseJson: '{"ok":true}',
    });

    const result = await claimIdempotencyKey("user_1", "key-1", "hash-b");

    expect(result).toEqual({ outcome: "conflict" });
  });

  it("reports in_progress when a concurrent attempt with the same fingerprint hasn't finished", async () => {
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      id: "idem_1",
      userId: "user_1",
      key: "key-1",
      requestHash: "hash-a",
      status: "in_progress",
      responseJson: null,
    });

    const result = await claimIdempotencyKey("user_1", "key-1", "hash-a");

    expect(result).toEqual({ outcome: "in_progress" });
    expect(prisma.idempotencyKey.update).not.toHaveBeenCalled();
  });

  it("reclaims a previously failed attempt with the same fingerprint for retry", async () => {
    prisma.idempotencyKey.create.mockRejectedValueOnce(uniqueConstraintError());
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      id: "idem_1",
      userId: "user_1",
      key: "key-1",
      requestHash: "hash-a",
      status: "failed",
      responseJson: null,
    });

    const result = await claimIdempotencyKey("user_1", "key-1", "hash-a");

    expect(result).toEqual({ outcome: "claimed", id: "idem_1" });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: "idem_1" },
      data: { status: "in_progress", responseJson: null },
    });
  });

  it("propagates unexpected errors from the initial insert", async () => {
    prisma.idempotencyKey.create.mockRejectedValueOnce(new Error("connection lost"));

    await expect(claimIdempotencyKey("user_1", "key-1", "hash-a")).rejects.toThrow(
      "connection lost"
    );
  });
});

describe("completeIdempotencyKey / failIdempotencyKey", () => {
  it("marks a record succeeded with the serialized response", async () => {
    await completeIdempotencyKey("idem_1", { settlement: { status: "submitted" } });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: "idem_1" },
      data: {
        status: "succeeded",
        responseJson: JSON.stringify({ settlement: { status: "submitted" } }),
      },
    });
  });

  it("marks a record failed", async () => {
    await failIdempotencyKey("idem_1");
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: { id: "idem_1" },
      data: { status: "failed" },
    });
  });
});
