import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  horizon: vi.fn(),
}));

vi.mock("../src/services/health", () => ({
  checkStellar: (...args: unknown[]) => h.horizon(...args),
  checkDatabase: vi.fn().mockResolvedValue(true),
  getReadiness: vi.fn().mockResolvedValue({
    status: "ok",
    database: { connected: true },
    stellar: { reachable: true, network: "public" },
    timestamp: new Date().toISOString(),
  }),
  getDeepHealth: vi.fn().mockResolvedValue({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: 1,
    checks: {
      database: { status: "up", latencyMs: 1 },
      stellar: { status: "up", latencyMs: 1 },
    },
    environment: { nodeEnv: "test", stellarNetwork: "public" },
  }),
  clearReadinessCache: vi.fn(),
}));

import { buildApp } from "../src/app";
import { getAuthHealth, preloadSep10SigningKey, signingKeyLoadable } from "../src/services/auth-health";
import { serverKeypair } from "../src/services/sep10";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.horizon.mockReset().mockResolvedValue(true);
  if (!app) app = await buildApp();
});

describe("getAuthHealth", () => {
  it("reports ok when the signing key loads and Horizon answers", async () => {
    const health = await getAuthHealth({
      loadSigningKey: () => "GSERVERSIGNINGKEYPUBLICKEY",
      checkHorizon: async () => true,
    });

    expect(health).toEqual({ status: "ok", checks: { signingKey: true, horizon: true } });
  });

  it("degrades when the signing key cannot be loaded", async () => {
    const health = await getAuthHealth({
      loadSigningKey: () => {
        throw new Error("bad SEP10_SIGNING_SECRET");
      },
      checkHorizon: async () => true,
    });

    expect(health.status).toBe("degraded");
    expect(health.checks).toEqual({ signingKey: false, horizon: true });
  });

  it("degrades when Horizon is unreachable", async () => {
    const health = await getAuthHealth({
      loadSigningKey: () => "GSERVERSIGNINGKEYPUBLICKEY",
      checkHorizon: async () => false,
    });

    expect(health.status).toBe("degraded");
    expect(health.checks).toEqual({ signingKey: true, horizon: false });
  });

  it("degrades instead of throwing when the Horizon probe rejects", async () => {
    const health = await getAuthHealth({
      loadSigningKey: () => "GSERVERSIGNINGKEYPUBLICKEY",
      checkHorizon: async () => {
        throw new Error("connection refused");
      },
    });

    expect(health).toEqual({ status: "degraded", checks: { signingKey: true, horizon: false } });
  });
});

describe("SEP-10 signing key caching", () => {
  it("returns the same keypair on every call instead of re-deriving it", () => {
    expect(serverKeypair()).toBe(serverKeypair());
  });

  it("preloads the configured key once at startup", () => {
    const publicKey = preloadSep10SigningKey();
    expect(publicKey).toBe(serverKeypair().publicKey());
    expect(signingKeyLoadable()).toBe(true);
  });

  it("reports an unloadable key as false rather than throwing", () => {
    expect(
      signingKeyLoadable(() => {
        throw new Error("nope");
      })
    ).toBe(false);
  });
});

describe("GET /health/auth", () => {
  it("returns 200 with booleans only when both dependencies are healthy", async () => {
    const response = await app.inject({ method: "GET", url: "/health/auth" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      checks: { signingKey: true, horizon: true },
    });
    expect(response.body).not.toMatch(/[GS][A-Z0-9]{55}/, "no key material in the response");
  });

  it("returns 503 when Horizon is unavailable", async () => {
    h.horizon.mockResolvedValueOnce(false);

    const response = await app.inject({ method: "GET", url: "/health/auth" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "degraded",
      checks: { signingKey: true, horizon: false },
    });
  });
});
