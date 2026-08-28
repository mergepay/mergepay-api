import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  feeStats: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: { $queryRaw: h.queryRaw },
}));

vi.mock("../src/services/network", () => ({
  getFeeStats: h.feeStats,
}));

import { buildApp } from "../src/app";
import { clearReadinessCache } from "../src/services/health";
import { Errors } from "../src/errors";
import { config } from "../src/config";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  clearReadinessCache();
  h.queryRaw.mockResolvedValue([{ 1: 1 }]);
  h.feeStats.mockResolvedValue({ minAcceptedFee: 100 });
  // checkAnchor reads process.env live at call time; unset it here (after
  // config's own startup validation already ran) so readiness reports the
  // anchor check as "disabled" instead of making a real network call.
  vi.stubEnv("ANCHOR_HOME_DOMAIN", "");
  if (!app) app = await buildApp();
});

describe("health routes", () => {
  it("returns liveness without checking dependencies", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.feeStats).not.toHaveBeenCalled();
  });

  it("returns ready when database and Stellar are available", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      checks: { database: "up", stellar: "up", anchor: "disabled" },
    });
  });

  it("returns not ready when the database is unavailable", async () => {
    h.queryRaw.mockRejectedValueOnce(new Error("password=secret SQL error"));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { database: "down" },
    });
    expect(JSON.stringify(response.json())).not.toContain("password");
    expect(JSON.stringify(response.json())).not.toContain("SQL");
  });

  it("returns not ready when Stellar times out", async () => {
    h.feeStats.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 2_000))
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { stellar: "down" },
    });
  }, 3_000);

  it("returns not ready when Stellar answers with an upstream error response", async () => {
    // A 5xx Horizon response surfaces through the service boundary as an
    // UPSTREAM_ERROR AppError, distinct from the timeout case above. The
    // readiness response must stay safe: the upstream error text is swallowed
    // and never echoed back.
    h.feeStats.mockRejectedValueOnce(
      Errors.upstream("Horizon returned 503 Service Unavailable")
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "not_ready",
      checks: { stellar: "down" },
    });
    expect(JSON.stringify(response.json())).not.toContain("503 Service Unavailable");
  });

  // ---------------------------------------------------------------------------
  // GET /health/deep
  // ---------------------------------------------------------------------------

  describe("deep health", () => {
    it("returns 200 when all critical dependencies are healthy", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(response.statusCode).toBe(200);
      expect(body.status).toBe("ok");
      expect(body.checks.database).toEqual({ status: "up", latencyMs: expect.any(Number) });
      expect(body.checks.stellar).toEqual({ status: "up", latencyMs: expect.any(Number) });
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.timestamp).toEqual(expect.any(String));
    });

    it("reports database latency in milliseconds", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof body.checks.database.latencyMs).toBe("number");
    });

    it("reports stellar latency in milliseconds", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(body.checks.stellar.latencyMs).toBeGreaterThanOrEqual(0);
      expect(typeof body.checks.stellar.latencyMs).toBe("number");
    });

    it("returns 503 when database is unavailable", async () => {
      h.queryRaw.mockRejectedValueOnce(new Error("connection refused"));
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.checks.database).toEqual({ status: "down", latencyMs: -1 });
      expect(body.checks.stellar.status).toBe("up");
    });

    it("returns 503 when Stellar is unavailable", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockRejectedValueOnce(new Error("Horizon unreachable"));

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.checks.database.status).toBe("up");
      expect(body.checks.stellar).toEqual({ status: "down", latencyMs: -1 });
    });

    it("returns 503 when both dependencies are unavailable", async () => {
      h.queryRaw.mockRejectedValueOnce(new Error("db down"));
      h.feeStats.mockRejectedValueOnce(new Error("horizon down"));

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.checks.database.status).toBe("down");
      expect(body.checks.stellar.status).toBe("down");
    });

    it("returns 503 when database times out", async () => {
      h.queryRaw.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 6_000))
      );
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.checks.database.status).toBe("down");
    }, 8_000);

    it("returns 503 when Stellar times out", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({}), 6_000))
      );

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(response.statusCode).toBe(503);
      expect(body.status).toBe("degraded");
      expect(body.checks.stellar.status).toBe("down");
    }, 8_000);

    it("reports environment status without exposing secrets", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(body.environment).toEqual({
        nodeEnv: expect.any(String),
        stellarNetwork: expect.any(String),
      });
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("DATABASE_URL");
      expect(serialized).not.toContain("JWT_SECRET");
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("ANCHOR_WEBHOOK_SECRET");
    });

    it("response conforms to the deep health schema shape", async () => {
      h.queryRaw.mockResolvedValueOnce([{ 1: 1 }]);
      h.feeStats.mockResolvedValueOnce({ minAcceptedFee: 100 });

      const response = await app.inject({ method: "GET", url: "/health/deep" });
      const body = response.json();

      expect(body).toMatchObject({
        status: expect.any(String),
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        checks: {
          database: { status: expect.any(String), latencyMs: expect.any(Number) },
          stellar: { status: expect.any(String), latencyMs: expect.any(Number) },
        },
        environment: {
          nodeEnv: expect.any(String),
          stellarNetwork: expect.any(String),
        },
      });
    });
  });
});
