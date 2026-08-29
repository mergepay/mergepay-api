import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  feeStats: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: { $queryRaw: h.queryRaw, $queryRawUnsafe: h.queryRawUnsafe },
}));

vi.mock("../src/services/network", () => ({
  getFeeStats: h.feeStats,
}));

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.queryRaw.mockResolvedValue([{ 1: 1 }]);
  h.queryRawUnsafe.mockResolvedValue([{ 1: 1 }]);
  h.feeStats.mockResolvedValue({ minAcceptedFee: 100 });
  h.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
  if (!app) app = await buildApp();
  global.fetch = h.fetch as typeof fetch;
});

describe("GET /health", () => {
  it("returns a lightweight liveness payload without touching deps", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      uptime: expect.any(Number),
      version: expect.any(String),
    });
    expect(h.queryRawUnsafe).not.toHaveBeenCalled();
    expect(h.feeStats).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("GET /health/ready", () => {
  it("returns 200 with dependency status when healthy", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      uptime: expect.any(Number),
      version: expect.any(String),
      database: { status: "up", latencyMs: expect.any(Number) },
      stellar: { status: "up", latencyMs: expect.any(Number) },
    });
  });

  it("returns 503 when the database is unavailable", async () => {
    h.queryRawUnsafe.mockRejectedValueOnce(new Error("connection refused"));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      database: { status: "down", latencyMs: expect.any(Number) },
    });
  });

  it("returns 503 when Horizon is unavailable", async () => {
    h.fetch.mockRejectedValueOnce(new Error("Horizon unreachable"));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      stellar: { status: "down", latencyMs: expect.any(Number) },
    });
  });

  it("never throws uncaught errors on slow dependency checks", async () => {
    h.queryRawUnsafe.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 3000))
    );
    h.fetch.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200 }), 3000))
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect([200, 503]).toContain(response.statusCode);
    expect(response.json().status).toBeTruthy();
  }, 7000);
});
