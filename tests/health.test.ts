import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  feeStats: vi.fn(),
}));

vi.mock("../src/db", () => ({
  prisma: { $queryRaw: h.queryRaw, $queryRawUnsafe: h.queryRawUnsafe },
}));

vi.mock("../src/services/network", () => ({
  getFeeStats: h.feeStats,
}));

import { buildApp } from "../src/app";
import { clearReadinessCache } from "../src/services/health";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  clearReadinessCache();
  h.queryRaw.mockResolvedValue([{ 1: 1 }]);
  h.queryRawUnsafe.mockResolvedValue([{ 1: 1 }]);
  h.feeStats.mockResolvedValue({ minAcceptedFee: 100 });
  if (!app) app = await buildApp();
});

// ---------------------------------------------------------------------------
// GET /health — Issue #32 readiness-based health check
// ---------------------------------------------------------------------------

describe("GET /health", () => {
  it("returns 200 with status ok when all checks pass", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.database.connected).toBe(true);
    expect(body.stellar.reachable).toBe(true);
    expect(body.stellar.network).toBeDefined();
    expect(typeof body.timestamp).toBe("string");
  });

  it("returns 503 with status degraded when database is down", async () => {
    h.queryRawUnsafe.mockRejectedValueOnce(new Error("connection refused"));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
    expect(body.stellar.reachable).toBe(true);
  });

  it("returns 503 with status degraded when stellar is unreachable", async () => {
    h.feeStats.mockRejectedValueOnce(new Error("Horizon unreachable"));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(true);
    expect(body.stellar.reachable).toBe(false);
  });

  it("returns 503 when both checks fail", async () => {
    h.queryRawUnsafe.mockRejectedValueOnce(new Error("db down"));
    h.feeStats.mockRejectedValueOnce(new Error("horizon down"));

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
    expect(body.stellar.reachable).toBe(false);
  });

  it("requires no authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// GET /health/live — pre-existing liveness probe
// ---------------------------------------------------------------------------

describe("GET /health/live", () => {
  it("returns liveness without checking dependencies", async () => {
    const response = await app.inject({ method: "GET", url: "/health/live" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      timestamp: expect.any(String),
    });
    expect(h.queryRawUnsafe).not.toHaveBeenCalled();
    expect(h.queryRaw).not.toHaveBeenCalled();
    expect(h.feeStats).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /health/ready — pre-existing readiness probe (now uses Issue #32 shape)
// ---------------------------------------------------------------------------

describe("GET /health/ready", () => {
  it("returns ready when database and Stellar are available", async () => {
    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.database.connected).toBe(true);
    expect(body.stellar.reachable).toBe(true);
  });

  it("returns not ready when the database is unavailable", async () => {
    h.queryRawUnsafe.mockRejectedValueOnce(new Error("password=secret SQL error"));

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
    expect(JSON.stringify(body)).not.toContain("password");
    expect(JSON.stringify(body)).not.toContain("SQL");
  });

  it("returns not ready when Stellar times out", async () => {
    // The service timeout is 5 seconds; the mock must exceed that to trigger rejection.
    h.feeStats.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve({}), 6_000))
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.stellar.reachable).toBe(false);
  }, 8_000);

  it("returns not ready when Stellar answers with an upstream error response", async () => {
    h.feeStats.mockRejectedValueOnce(
      new Error("Horizon returned 503 Service Unavailable")
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.stellar.reachable).toBe(false);
    expect(JSON.stringify(body)).not.toContain("503 Service Unavailable");
  });

  it("returns not ready when the database check times out", async () => {
    h.queryRawUnsafe.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve([{ 1: 1 }]), 6_000))
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
  }, 8_000);

  it("does not leak connection-string details when the database fails", async () => {
    h.queryRawUnsafe.mockRejectedValueOnce(
      new Error(
        "connect ECONNREFUSED postgresql://user:secret@db.internal:5432/mergepay"
      )
    );

    const response = await app.inject({ method: "GET", url: "/health/ready" });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.status).toBe("degraded");
    expect(body.database.connected).toBe(false);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("postgresql://");
    expect(serialized).not.toContain("db.internal");
    expect(serialized).not.toContain("secret");
  });

  it("serves health probes without authentication", async () => {
    // No Authorization header at all: health routes are outside the auth
    // plugin and application business authorization, so a probe never 401s.
    const live = await app.inject({ method: "GET", url: "/health/live" });
    expect(live.statusCode).toBe(200);

    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect([200, 503]).toContain(ready.statusCode);
  });
});

// ---------------------------------------------------------------------------
// GET /health/deep — pre-existing deep health probe
// ---------------------------------------------------------------------------

describe("GET /health/deep", () => {
  it("returns 200 when all critical dependencies are healthy", async () => {
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
    const response = await app.inject({ method: "GET", url: "/health/deep" });
    const body = response.json();

    expect(body.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.checks.database.latencyMs).toBe("number");
  });

  it("reports stellar latency in milliseconds", async () => {
    const response = await app.inject({ method: "GET", url: "/health/deep" });
    const body = response.json();

    expect(body.checks.stellar.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof body.checks.stellar.latencyMs).toBe("number");
  });

  it("returns 503 when database is unavailable", async () => {
    h.queryRaw.mockRejectedValueOnce(new Error("connection refused"));

    const response = await app.inject({ method: "GET", url: "/health/deep" });
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.database).toEqual({ status: "down", latencyMs: -1 });
    expect(body.checks.stellar.status).toBe("up");
  });

  it("returns 503 when Stellar is unavailable", async () => {
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

    const response = await app.inject({ method: "GET", url: "/health/deep" });
    const body = response.json();

    expect(response.statusCode).toBe(503);
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("down");
  }, 8_000);

  it("returns 503 when Stellar times out", async () => {
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
