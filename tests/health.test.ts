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
});
