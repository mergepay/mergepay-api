import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../src/db", () => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(async () => ({ count: 0 })),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(), group: model(), groupMember: model(), invite: model(), invitation: model(),
    expense: model(), expenseShare: model(), settlement: model(), treasuryTransaction: model(),
    auditLog: model(), idempotencyKey: model(), refreshToken: model(),
    $transaction: vi.fn(async (arg: any) => typeof arg === "function" ? arg(prisma) : Promise.all(arg)),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
  };
  return { prisma };
});

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

describe("request id logging/correlation", () => {
  it("returns x-request-id and generates unique ids when absent", async () => {
    const a = await app.inject({ method: "GET", url: "/health" });
    const b = await app.inject({ method: "GET", url: "/health" });
    expect(a.statusCode).toBe(200);
    expect(a.headers["x-request-id"]).toBeTruthy();
    expect(b.headers["x-request-id"]).toBeTruthy();
    expect(a.headers["x-request-id"]).not.toBe(b.headers["x-request-id"]);
  });

  it("echoes inbound x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "req-fixed-123" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-request-id"]).toBe("req-fixed-123");
  });
});
