import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  feeStats: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: {
    $queryRaw: h.queryRaw,
    $queryRawUnsafe: h.queryRawUnsafe,
  },
}));

vi.mock("../src/services/network", () => ({
  getFeeStats: (...args: unknown[]) => h.feeStats(...args),
}));

import { buildApp } from "../src/app";
import { buildLoggerOptions } from "../src/lib/logger";
import { clearReadinessCache } from "../src/services/health";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  // The readiness probe is cached for a few seconds; reset it so each test
  // observes the dependency mocks it just configured.
  clearReadinessCache();
  h.queryRaw.mockResolvedValue([{ 1: 1 }]);
  h.queryRawUnsafe.mockResolvedValue([{ 1: 1 }]);
  h.feeStats.mockResolvedValue({ minAcceptedFee: 100 });
  h.fetch.mockResolvedValue({ ok: true, status: 200, text: async () => "ok" });
  if (!app) app = await buildApp();
  global.fetch = h.fetch as typeof fetch;
});

describe("GET /health/live", () => {
  it("returns a lightweight liveness payload without touching deps", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      timestamp: expect.any(String),
    });
  });
});

describe("GET /health", () => {
  it("returns dependency status", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      database: { connected: true },
      stellar: { reachable: true },
      timestamp: expect.any(String),
    });
  });

  it("returns unhealthy when the database ping exceeds the short timeout", async () => {
    // Never resolves — simulates a stalled query / exhausted connection pool.
    h.queryRawUnsafe.mockImplementationOnce(() => new Promise(() => {}));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      database: { connected: false },
      stellar: { reachable: true },
      timestamp: expect.any(String),
    });
  }, 6000);

  it("logs a structured warning once for a degraded readiness result", async () => {
    const lines: Record<string, unknown>[] = [];
    const capture = {
      write(chunk: string) {
        lines.push(JSON.parse(chunk));
      },
    };
    const loggingApp = await buildApp({
      logger: { ...buildLoggerOptions({ level: "warn" }), stream: capture },
    });
    h.queryRawUnsafe.mockRejectedValueOnce(new Error("connection dropped"));
    clearReadinessCache();

    const first = await loggingApp.inject({ method: "GET", url: "/health" });
    const second = await loggingApp.inject({ method: "GET", url: "/health" });

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(503);
    const warnings = lines.filter(
      (line) => line.msg === "Health readiness check is degraded"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ databaseConnected: false });

    await loggingApp.close();
  });
});

describe("GET /health/deep", () => {
  it("returns detailed health with dependency status when healthy", async () => {
    const response = await app.inject({ method: "GET", url: "/health/deep" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      uptime: expect.any(Number),
      timestamp: expect.any(String),
      checks: {
        database: { status: "up", latencyMs: expect.any(Number) },
        stellar: { status: "up", latencyMs: expect.any(Number) },
      },
    });
  });

  it("returns 503 when the database is unavailable", async () => {
    h.queryRaw.mockRejectedValueOnce(new Error("connection refused"));

    const response = await app.inject({ method: "GET", url: "/health/deep" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      checks: {
        database: { status: "down", latencyMs: expect.any(Number) },
      },
    });
  });

  it("returns 503 when Horizon is unavailable", async () => {
    h.feeStats.mockRejectedValueOnce(new Error("Horizon unreachable"));

    const response = await app.inject({ method: "GET", url: "/health/deep" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "degraded",
      checks: {
        stellar: { status: "down", latencyMs: expect.any(Number) },
      },
    });
  });

  it("never throws uncaught errors on slow dependency checks", async () => {
    h.queryRaw.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 3000))
    );
    h.feeStats.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({ minAcceptedFee: 100 }), 3000))
    );

    const response = await app.inject({ method: "GET", url: "/health/deep" });

    expect([200, 503]).toContain(response.statusCode);
    expect(response.json().status).toBeTruthy();
  }, 7000);
});

describe("OpenAPI docs", () => {
  it("exposes Swagger UI and JSON spec", async () => {
    const uiResponse = await app.inject({ method: "GET", url: "/docs" });
    expect(uiResponse.statusCode).toBe(200);
    expect(uiResponse.headers["content-type"]).toContain("text/html");

    const specResponse = await app.inject({ method: "GET", url: "/docs/json" });
    expect(specResponse.statusCode).toBe(200);
    expect(specResponse.headers["content-type"]).toContain("application/json");
    expect(specResponse.json().openapi).toBe("3.0.0");
    expect(specResponse.json().paths).toBeDefined();
  });
});
