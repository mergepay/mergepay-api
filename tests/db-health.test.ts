import { describe, it, expect, vi } from "vitest";
import { checkDatabaseConnection } from "../src/db";
import { checkDatabaseConnection as checkFromServices } from "../src/services/db";
import { checkDatabaseConnection as checkFromLib } from "../src/lib/prisma";

describe("checkDatabaseConnection", () => {
  it("returns true when database ping query succeeds", async () => {
    const mockPrisma: any = {
      $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    };

    const result = await checkDatabaseConnection(mockPrisma);
    expect(result).toBe(true);
    expect(mockPrisma.$queryRaw).toHaveBeenCalled();
  });

  it("handles connection failures gracefully by returning false without throwing", async () => {
    const mockPrisma: any = {
      $queryRaw: vi.fn().mockRejectedValue(new Error("Connection terminated unexpectedly")),
    };

    const result = await checkDatabaseConnection(mockPrisma);
    expect(result).toBe(false);
  });

  it("handles query timeouts gracefully by returning false", async () => {
    const mockPrisma: any = {
      $queryRaw: vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 200))
      ),
    };

    const result = await checkDatabaseConnection(mockPrisma, 50);
    expect(result).toBe(false);
  });

  it("is exported cleanly from src/services/db and src/lib/prisma", () => {
    expect(typeof checkFromServices).toBe("function");
    expect(typeof checkFromLib).toBe("function");
  });
});
