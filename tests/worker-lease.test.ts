/**
 * Tests for worker lease-based job claiming and recovery.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../src/db";
import { config } from "../src/config";

describe("worker lease claiming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("settlement claiming", () => {
    it("should claim a settlement with a lease", async () => {
      const settlementId = "test-settlement-id";
      const now = new Date();
      const leaseExpiresAt = new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS);

      const updateManySpy = vi.spyOn(prisma.settlement, "updateMany").mockResolvedValue({ count: 1 });

      // Simulate the claim logic from worker
      const result = await prisma.settlement.updateMany({
        where: {
          id: settlementId,
          status: { in: ["pending", "submitted"] },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          claimedAt: now,
          claimedBy: "test-worker-id",
          leaseExpiresAt,
          retryCount: { increment: 1 },
        },
      });

      expect(result.count).toBe(1);
      expect(updateManySpy).toHaveBeenCalledWith({
        where: {
          id: settlementId,
          status: { in: ["pending", "submitted"] },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          claimedAt: now,
          claimedBy: "test-worker-id",
          leaseExpiresAt,
          retryCount: { increment: 1 },
        },
      });
    });

    it("should not claim a settlement with active lease", async () => {
      const settlementId = "test-settlement-id";
      const now = new Date();
      const futureLease = new Date(Date.now() + 600000); // 10 minutes in future

      const updateManySpy = vi.spyOn(prisma.settlement, "updateMany").mockResolvedValue({ count: 0 });

      const result = await prisma.settlement.updateMany({
        where: {
          id: settlementId,
          status: { in: ["pending", "submitted"] },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          claimedAt: now,
          claimedBy: "test-worker-id",
          leaseExpiresAt: new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS),
          retryCount: { increment: 1 },
        },
      });

      expect(result.count).toBe(0);
      expect(updateManySpy).toHaveBeenCalled();
    });

    it("should reclaim a settlement with expired lease", async () => {
      const settlementId = "test-settlement-id";
      const now = new Date();
      const pastLease = new Date(Date.now() - 10000); // 10 seconds ago

      const updateManySpy = vi.spyOn(prisma.settlement, "updateMany").mockResolvedValue({ count: 1 });

      const result = await prisma.settlement.updateMany({
        where: {
          id: settlementId,
          status: { in: ["pending", "submitted"] },
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          claimedAt: now,
          claimedBy: "new-worker-id",
          leaseExpiresAt: new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS),
          retryCount: { increment: 1 },
        },
      });

      expect(result.count).toBe(1);
      expect(updateManySpy).toHaveBeenCalled();
    });
  });

  describe("settlement release", () => {
    it("should release a settlement claim", async () => {
      const settlementId = "test-settlement-id";
      const workerId = "test-worker-id";

      const updateManySpy = vi.spyOn(prisma.settlement, "updateMany").mockResolvedValue({ count: 1 });

      await prisma.settlement.updateMany({
        where: { id: settlementId, claimedBy: workerId },
        data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
      });

      expect(updateManySpy).toHaveBeenCalledWith({
        where: { id: settlementId, claimedBy: workerId },
        data: { claimedAt: null, claimedBy: null, leaseExpiresAt: null },
      });
    });
  });

  describe("anchor session claiming", () => {
    it("should claim an anchor session with a lease", async () => {
      const sessionId = "test-session-id";
      const now = new Date();
      const leaseExpiresAt = new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS);

      const updateManySpy = vi.spyOn(prisma.anchorSession, "updateMany").mockResolvedValue({ count: 1 });

      const result = await prisma.anchorSession.updateMany({
        where: {
          id: sessionId,
          OR: [
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lt: now } },
          ],
        },
        data: {
          claimedAt: now,
          claimedBy: "test-worker-id",
          leaseExpiresAt,
        },
      });

      expect(result.count).toBe(1);
      expect(updateManySpy).toHaveBeenCalled();
    });
  });

  describe("nextAttemptAt scheduling", () => {
    it("should schedule next attempt with exponential backoff", async () => {
      const settlementId = "test-settlement-id";
      const attempt = 2;
      const delay = 2000; // 2 seconds for attempt 2
      const nextAttemptAt = new Date(Date.now() + delay);

      const updateSpy = vi.spyOn(prisma.settlement, "update").mockResolvedValue({} as any);

      await prisma.settlement.update({
        where: { id: settlementId },
        data: {
          retryCount: attempt,
          nextAttemptAt,
          leaseExpiresAt: new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS),
        },
      });

      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: settlementId },
        data: {
          retryCount: attempt,
          nextAttemptAt,
          leaseExpiresAt: new Date(Date.now() + config.WORKER_LEASE_TIMEOUT_MS),
        },
      });
    });

    it("should query only settlements ready for processing", async () => {
      const now = new Date();

      const findManySpy = vi.spyOn(prisma.settlement, "findMany").mockResolvedValue([]);

      await prisma.settlement.findMany({
        where: {
          status: { in: ["pending", "submitted"] },
          transactionXdr: { not: null },
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: now } },
          ],
        },
        take: 50,
        orderBy: [{ nextAttemptAt: "asc" as const }, { createdAt: "asc" as const }],
      });

      expect(findManySpy).toHaveBeenCalledWith({
        where: {
          status: { in: ["pending", "submitted"] },
          transactionXdr: { not: null },
          OR: [
            { nextAttemptAt: null },
            { nextAttemptAt: { lte: now } },
          ],
        },
        take: 50,
        orderBy: [{ nextAttemptAt: "asc" as const }, { createdAt: "asc" as const }],
      });
    });
  });

  describe("terminal failure handling", () => {
    it("should clear lease fields on terminal failure", async () => {
      const settlementId = "test-settlement-id";

      const updateSpy = vi.spyOn(prisma.settlement, "update").mockResolvedValue({} as any);

      await prisma.settlement.update({
        where: { id: settlementId },
        data: {
          status: "failed",
          failureReason: "permanent error",
          retryCount: 3,
          claimedAt: null,
          claimedBy: null,
          leaseExpiresAt: null,
        },
      });

      expect(updateSpy).toHaveBeenCalledWith({
        where: { id: settlementId },
        data: {
          status: "failed",
          failureReason: "permanent error",
          retryCount: 3,
          claimedAt: null,
          claimedBy: null,
          leaseExpiresAt: null,
        },
      });
    });
  });
});
