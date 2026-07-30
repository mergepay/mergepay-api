import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const prisma: any = {
    anchorSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    auditLog: { create: vi.fn() },
    $transaction: vi.fn(async (fn: any) => fn(prisma)),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import {
  applyAnchorSessionTransition,
  canTransitionAnchorStatus,
  isTerminalAnchorStatus,
} from "../src/services/anchor-status";

const prisma = h.prisma;

const fakeSession = (over: Record<string, any> = {}) => ({
  id: "session_1",
  userId: "user_1",
  anchorName: "Test Anchor",
  kind: "deposit",
  assetCode: "USDC",
  interactiveUrl: null,
  externalTransactionId: "ext_1",
  anchorToken: null,
  status: "incomplete",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("canTransitionAnchorStatus / isTerminalAnchorStatus", () => {
  it("treats completed and refunded as terminal", () => {
    expect(isTerminalAnchorStatus("completed")).toBe(true);
    expect(isTerminalAnchorStatus("refunded")).toBe(true);
    expect(isTerminalAnchorStatus("pending_anchor")).toBe(false);
  });

  it("allows the documented forward transitions", () => {
    expect(canTransitionAnchorStatus("incomplete", "pending_user_transfer_start")).toBe(true);
    expect(canTransitionAnchorStatus("pending_user_transfer_start", "pending_anchor")).toBe(true);
    expect(canTransitionAnchorStatus("pending_anchor", "completed")).toBe(true);
    expect(canTransitionAnchorStatus("error", "refunded")).toBe(true);
  });

  it("rejects regressions out of terminal states", () => {
    expect(canTransitionAnchorStatus("completed", "pending_anchor")).toBe(false);
    expect(canTransitionAnchorStatus("refunded", "completed")).toBe(false);
    expect(canTransitionAnchorStatus("completed", "error")).toBe(false);
  });

  it("rejects a regression from error back to a pending state", () => {
    expect(canTransitionAnchorStatus("error", "pending_anchor")).toBe(false);
    expect(canTransitionAnchorStatus("error", "incomplete")).toBe(false);
  });

  it("rejects skipping backwards from pending_anchor to incomplete", () => {
    expect(canTransitionAnchorStatus("pending_anchor", "incomplete")).toBe(false);
  });
});

describe("applyAnchorSessionTransition", () => {
  it("applies an allowed transition and writes an audit record atomically", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "pending_anchor" }));
    prisma.anchorSession.update.mockResolvedValue(
      fakeSession({ status: "completed" })
    );

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "webhook",
    });

    expect(result.changed).toBe(true);
    expect(result.session.status).toBe("completed");
    expect(prisma.anchorSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { status: "completed" },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "anchor_session.status_changed",
        entityType: "anchor_session",
        entityId: "session_1",
        metadata: { from: "pending_anchor", to: "completed", source: "webhook" },
      }),
    });
  });

  it("is idempotent for a repeated identical status and writes no audit record", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "completed" }));

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "completed",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("ignores an invalid regression from a terminal state without changing anything", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "completed" }));

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_anchor",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(result.session.status).toBe("completed");
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("ignores an out-of-order update that would regress an in-flight session", async () => {
    // A stale "pending_user_transfer_start" webhook arrives after the
    // session already advanced to "pending_anchor".
    prisma.anchorSession.findUnique.mockResolvedValue(fakeSession({ status: "pending_anchor" }));

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_user_transfer_start",
      source: "webhook",
    });

    expect(result.changed).toBe(false);
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("persists extra data alongside a duplicate status without re-auditing", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ status: "pending_user_transfer_start" })
    );
    prisma.anchorSession.update.mockResolvedValue(
      fakeSession({ status: "pending_user_transfer_start", interactiveUrl: "https://retry" })
    );

    const result = await applyAnchorSessionTransition({
      sessionId: "session_1",
      nextStatus: "pending_user_transfer_start",
      source: "user",
      extraData: { interactiveUrl: "https://retry" },
    });

    expect(result.changed).toBe(false);
    expect(prisma.anchorSession.update).toHaveBeenCalledWith({
      where: { id: "session_1" },
      data: { interactiveUrl: "https://retry" },
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("enforces session ownership when an owner is specified", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(
      fakeSession({ userId: "someone_else" })
    );

    await expect(
      applyAnchorSessionTransition({
        sessionId: "session_1",
        nextStatus: "pending_user_transfer_start",
        source: "user",
        ownerUserId: "user_1",
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.anchorSession.update).not.toHaveBeenCalled();
  });

  it("throws not found for a missing session", async () => {
    prisma.anchorSession.findUnique.mockResolvedValue(null);

    await expect(
      applyAnchorSessionTransition({
        sessionId: "missing",
        nextStatus: "completed",
        source: "poll",
      })
    ).rejects.toMatchObject({ status: 404 });
  });
});
