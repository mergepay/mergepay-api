import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  return {
    prisma: {
      auditLog: {
        create: vi.fn(),
      },
    },
  };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { log, auditLog } from "../src/lib/auditLog";

describe("auditLog helper module", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should insert audit log entry into database when log is called", async () => {
    h.prisma.auditLog.create.mockResolvedValueOnce({
      id: "audit_1",
      action: "GROUP_CREATED",
      userId: "user_1",
      groupId: "group_1",
      details: { name: "Test Group" },
      createdAt: new Date(),
    });

    await log("GROUP_CREATED", "user_1", "group_1", { name: "Test Group" });

    expect(h.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "GROUP_CREATED",
        userId: "user_1",
        groupId: "group_1",
        details: { name: "Test Group" },
      },
    });
  });

  it("should export auditLog object with log method", async () => {
    h.prisma.auditLog.create.mockResolvedValueOnce({
      id: "audit_2",
      action: "SETTLEMENT_CONFIRMED",
      userId: "user_2",
      groupId: "group_2",
      details: null,
      createdAt: new Date(),
    });

    await auditLog.log("SETTLEMENT_CONFIRMED", "user_2", "group_2");

    expect(h.prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        action: "SETTLEMENT_CONFIRMED",
        userId: "user_2",
        groupId: "group_2",
        details: undefined,
      },
    });
  });

  it("should handle error gracefully without throwing exception", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    h.prisma.auditLog.create.mockRejectedValueOnce(new Error("DB Connection Error"));

    await expect(log("EXPENSE_CREATED", "user_1", "group_1")).resolves.not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith("Failed to write audit log:", expect.any(Error));

    consoleSpy.mockRestore();
  });
});
