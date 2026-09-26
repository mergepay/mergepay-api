/**
 * Issue #538 — rate limiting for sensitive authentication/payment endpoints.
 *
 * The per-route policies already exist (src/lib/rate-limit.ts) and are
 * exercised in synthetic Fastify apps elsewhere (tests/rateLimit.test.ts,
 * tests/rate-limit-headers.test.ts, tests/rate-limit-policies.test.ts). What
 * those suites cannot catch is a regression in the *real* wiring — e.g.
 * `rateLimited("authChallenge")` accidentally dropped from a route declaration
 * in src/routes/auth.ts — and none of them asserts the production 429 JSON
 * envelope (`code: "RATE_LIMITED"`) produced through the real error handler.
 *
 * This suite boots the actual application via buildApp() and drives real
 * sensitive routes past their configured budgets, verifying:
 *   1. every sensitive route carries its per-route policy (limit headers show
 *      the policy's max, not the global default);
 *   2. exceeding the budget returns 429 with the standard headers and the
 *      clean JSON error envelope (`RATE_LIMITED` + `requestId`);
 *   3. budgets are independent per route and per client identity.
 *
 * All handlers fail fast on mocked Prisma (validation / membership checks
 * before any Horizon call), so no network or database is touched.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(async () => ({})),
    createMany: vi.fn(async () => ({})),
    findUnique: vi.fn(async () => null),
    findFirst: vi.fn(async () => null),
    findMany: vi.fn(async () => []),
    update: vi.fn(async () => ({})),
    updateMany: vi.fn(async () => ({ count: 0 })),
    upsert: vi.fn(async () => ({})),
    delete: vi.fn(async () => ({})),
    deleteMany: vi.fn(async () => ({ count: 0 })),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    refreshToken: model(),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(async () => 1),
    $disconnect: vi.fn(),
  };
  const mockFetchBaseFee = vi.fn(async () => 100);
  return { prisma, mockFetchBaseFee };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: h.mockFetchBaseFee,
        feeStats: h.mockFetchBaseFee,
      })),
    },
  };
});

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { rateLimitPolicies } from "../src/lib/rate-limit";
import { Keypair } from "@stellar/stellar-sdk";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
const policies = rateLimitPolicies();

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

/** Bearer token for an authenticated caller (user-or-ip keyed policies). */
function authHeader() {
  const token = signToken({
    id: "user_rate_limit_test",
    stellarPublicKey: Keypair.random().publicKey(),
  });
  return { authorization: `Bearer ${token}` };
}

/** Drive one route until 429, then assert the production 429 contract. */
async function exhaustAndAssert(opts: {
  method: "GET" | "POST";
  url: string;
  max: number;
  headers?: Record<string, string>;
  payload?: unknown;
  label: string;
}) {
  const { method, url, max, headers, payload, label } = opts;

  let saw200 = 0;
  for (let i = 0; i < max; i++) {
    const res = await app.inject({ method, url, headers, payload });
    // Handlers may legitimately fail (mocked Prisma) — that is fine; what
    // matters is that the limiter did not reject them early.
    expect(res.statusCode, `${label} request ${i + 1}`).not.toBe(429);
    if (res.statusCode < 500) saw200++;
  }
  expect(saw200, `${label}: in-budget requests were accepted`).toBe(max);

  const blocked = await app.inject({ method, url, headers, payload });
  expect(blocked.statusCode, `${label}: budget exhausted`).toBe(429);
  expect(blocked.headers["x-ratelimit-limit"]).toBe(String(max));
  expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
  expect(blocked.headers["retry-after"]).toBeDefined();

  const body = blocked.json();
  expect(body.code).toBe("RATE_LIMITED");
  expect(body.requestId).toBeTruthy();
  expect(typeof body.message).toBe("string");
  return blocked;
}

describe("rate limiting on the real app wiring (#538)", () => {
  it("POST /auth/challenge — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.authChallenge.max;
    const client = Keypair.random();
    await exhaustAndAssert({
      method: "POST",
      url: "/auth/challenge",
      max,
      payload: { account: client.publicKey() },
      label: "auth/challenge",
    });
  });

  it("POST /auth/verify — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.authVerify.max;
    // Malformed bodies fail validation immediately — no crypto, no Horizon.
    await exhaustAndAssert({
      method: "POST",
      url: "/auth/verify",
      max,
      payload: {},
      label: "auth/verify",
    });
  });

  it("POST /auth/refresh — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.authVerify.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/auth/refresh",
      max,
      payload: { refreshToken: "invalid_refresh_token" },
      label: "auth/refresh",
    });
  });

  it("POST /expenses/:id/settle — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.settlementCreate.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/expenses/00000000-0000-0000-0000-000000000000/settle",
      max,
      headers: authHeader(),
      payload: { signedXdr: "x" },
      label: "expenses/:id/settle",
    });
  });

  it("POST /groups/:id/settlements — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.settlementCreate.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/groups/00000000-0000-0000-0000-000000000000/settlements",
      max,
      headers: authHeader(),
      payload: {},
      label: "groups/:id/settlements",
    });
  });

  it("POST /settlements/:id/confirm — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.settlementConfirm.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/settlements/settle_x/confirm",
      max,
      headers: authHeader(),
      payload: { signedXdr: "x" },
      label: "settlements/:id/confirm",
    });
  });

  it("POST /treasury-transactions/:id/confirm — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.treasurySubmit.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/treasury-transactions/tx_x/confirm",
      max,
      headers: authHeader(),
      payload: { signedXdr: "x" },
      label: "treasury-transactions/:id/confirm",
    });
  });

  it("auth buckets are keyed by IP — same budget for signed-in and anonymous callers", async () => {
    // auth policies are keyed by IP ("ip"), so a bearer token must not give a
    // second bucket: exhaust anonymously, then confirm an authenticated
    // request on the same route is blocked too.
    const max = policies.authChallenge.max;
    const client = Keypair.random();
    for (let i = 0; i < max; i++) {
      await app.inject({
        method: "POST",
        url: "/auth/challenge",
        payload: { account: client.publicKey() },
      });
    }
    const authed = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: authHeader(),
      payload: { account: client.publicKey() },
    });
    expect(authed.statusCode).toBe(429);
  });

  it("per-route budget is independent of the global bucket", async () => {
    // Exhaust the (smaller) auth-verify budget; a request to a route with no
    // per-route policy must still have its own global budget available.
    const max = policies.authVerify.max;
    for (let i = 0; i < max; i++) {
      await app.inject({ method: "POST", url: "/auth/verify", payload: {} });
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {},
    });
    expect(blocked.statusCode).toBe(429);

    const other = await app.inject({
      method: "GET",
      url: "/history",
      headers: authHeader(),
    });
    expect(other.statusCode).not.toBe(429);
  });

  it("429 responses never leak rate-limit internals beyond the standard headers", async () => {
    const max = policies.authVerify.max;
    for (let i = 0; i < max + 1; i++) {
      await app.inject({ method: "POST", url: "/auth/verify", payload: {} });
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {},
    });
    const body = blocked.json();
    // The envelope carries only the documented fields.
    expect(Object.keys(body).sort()).toEqual([
      "code",
      "error",
      "message",
      "requestId",
    ]);
    expect(body.message).not.toContain("bucket");
    expect(body.message).not.toContain("key");
  });
});
