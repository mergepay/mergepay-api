import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";

vi.mock("../src/db", () => ({
  prisma: {
    user: { upsert: vi.fn(), findUnique: vi.fn() },
    auditLog: { create: vi.fn(async () => ({})) },
    refreshToken: { create: vi.fn(async () => ({})) },
    $disconnect: vi.fn(),
  },
}));

import { buildApp } from "../src/app";
import { rateLimitPolicies } from "../src/lib/rate-limit";

let app: Awaited<ReturnType<typeof buildApp>>;
let routes: Array<{ method?: string | string[]; url?: string; config?: Record<string, unknown> }>;

beforeAll(async () => {
  routes = [];
  app = await buildApp({ onRoute: (r) => routes.push(r) });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

function findRoute(method: string, url: string) {
  return routes.find((r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    return methods.includes(method) && r.url === url;
  });
}

describe("SEP-10 per-route rate limit wiring (#1013)", () => {
  it("defines distinct authChallenge and authVerify policies", () => {
    const p = rateLimitPolicies();
    expect(p.authChallenge.max).toBeGreaterThan(0);
    expect(p.authVerify.max).toBeGreaterThan(0);
    expect(p.authChallenge.prefix).not.toBe(p.authVerify.prefix);
  });

  it("applies authChallenge policy to POST /api/v1/auth/challenge", () => {
    const route = findRoute("POST", "/api/v1/auth/challenge");
    expect(route).toBeTruthy();
    expect(route?.config?.rateLimitPolicy).toBe("authChallenge");
  });

  it("applies authVerify policy to POST /api/v1/auth/verify", () => {
    const route = findRoute("POST", "/api/v1/auth/verify");
    expect(route).toBeTruthy();
    expect(route?.config?.rateLimitPolicy).toBe("authVerify");
  });

  it("returns 429 with retry-after when challenge limit is exceeded", async () => {
    const limited = await buildApp();
    await limited.ready();
    const max = rateLimitPolicies().authChallenge.max;
    const ip = "198.51.100.77";
    const account = Keypair.random().publicKey();

    for (let i = 0; i < max; i++) {
      const res = await limited.inject({
        method: "POST",
        url: "/api/v1/auth/challenge",
        remoteAddress: ip,
        payload: { account },
      });
      expect(res.statusCode).not.toBe(429);
    }

    const blocked = await limited.inject({
      method: "POST",
      url: "/api/v1/auth/challenge",
      remoteAddress: ip,
      payload: { account },
    });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
    const body = blocked.json();
    expect(body.code).toBe("RATE_LIMITED");
    expect(body.requestId).toBeTruthy();
    await limited.close();
  });
});
