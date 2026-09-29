/**
 * Integration coverage for issue #352 — rate limiting on the SEP-10 auth
 * endpoints.
 *
 * `POST /auth/challenge` and `POST /auth/verify` are the only unauthenticated,
 * credential-bearing surfaces in the API: anyone can ask the server to build a
 * challenge and anyone can submit a signed envelope to exchange for a session.
 * Without a bound they are a free brute-force / DoS target, so both carry an
 * explicit per-route policy from `src/lib/rate-limit.ts`. This suite boots the
 * real application via `buildApp()` — real plugin registration, the real
 * `@fastify/rate-limit` wiring, and the real error handler — and drives the
 * routes past their configured budgets to prove the guard is actually reached.
 *
 * It complements `tests/rate-limit-sensitive-routes.test.ts` (same assertions,
 * run in the unit suite) by living in `tests/integration/`, which is the layer
 * the issue named and is executed by `npm run test:integration`. The handlers
 * require no database or Horizon access: a challenge request is built purely
 * in-process, and a verify request with an empty body is rejected by request
 * validation before any cryptographic work or upstream call, so the only
 * variable under test is the limiter itself.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Keypair } from "@stellar/stellar-sdk";
import { buildApp } from "../../src/app";
import { rateLimitPolicies } from "../../src/lib/rate-limit";

const LIMIT_HEADER = "x-ratelimit-limit";
const REMAINING_HEADER = "x-ratelimit-remaining";
const RESET_HEADER = "x-ratelimit-reset";
const RETRY_AFTER_HEADER = "retry-after";

/** Client IP used by `app.inject` unless overridden, and the shared default. */
const DEFAULT_IP = "127.0.0.1";

const policies = rateLimitPolicies();

let app: FastifyInstance;

beforeEach(async () => {
  // A fresh instance per test: the in-memory counter store is per-process, so
  // each case starts with empty buckets and the tests stay order-independent.
  app = await buildApp();
});

afterEach(async () => {
  await app.close();
});

interface InjectOptions {
  url: string;
  payload?: unknown;
  remoteAddress?: string;
}

function post(options: InjectOptions) {
  return app.inject({
    method: "POST",
    url: options.url,
    payload: options.payload,
    remoteAddress: options.remoteAddress ?? DEFAULT_IP,
  });
}

/**
 * Issue `max` in-budget requests, then assert the next one is rejected with the
 * production 429 contract: the standard rate-limit headers, `Retry-After`, and
 * the clean JSON error envelope carrying `RATE_LIMITED` and a requestId.
 */
async function exhaust(options: {
  url: string;
  payload: unknown;
  max: number;
  remoteAddress?: string;
  expectInBudget: (status: number, requestIndex: number) => void;
}) {
  const { url, payload, max, remoteAddress, expectInBudget } = options;

  for (let i = 0; i < max; i++) {
    const res = await post({ url, payload, remoteAddress });
    expect(res.statusCode, `${url} request ${i + 1} of ${max}`).not.toBe(429);
    expectInBudget(res.statusCode, i);
  }

  const blocked = await post({ url, payload, remoteAddress });
  expect(blocked.statusCode, `${url}: request ${max + 1} crosses the budget`).toBe(429);
  expect(blocked.headers[LIMIT_HEADER]).toBe(String(max));
  expect(blocked.headers[REMAINING_HEADER]).toBe("0");
  expect(blocked.headers[RESET_HEADER]).toBeDefined();
  expect(blocked.headers[RETRY_AFTER_HEADER]).toBeDefined();

  const body = blocked.json();
  expect(body.code).toBe("RATE_LIMITED");
  expect(body.requestId).toBeTruthy();
  expect(typeof body.message).toBe("string");
}

describe("SEP-10 auth rate limiting (#352)", () => {
  it("rejects requests past the POST /auth/challenge budget with 429", async () => {
    const { max, timeWindow } = policies.authChallenge;
    const account = Keypair.random().publicKey();

    await exhaust({
      url: "/auth/challenge",
      payload: { account },
      max,
      expectInBudget: (status) => expect(status).toBe(200),
    });

    // Sanity: the policy is finite and its window is the documented one.
    expect(max).toBeGreaterThan(0);
    expect(timeWindow).toBeGreaterThan(0);
  });

  it("rejects requests past the POST /auth/verify budget with 429", async () => {
    await exhaust({
      url: "/auth/verify",
      payload: {},
      max: policies.authVerify.max,
      // An empty body fails the Zod contract with a 4xx before any signature
      // check; that is still inside the budget, which is all this asserts.
      expectInBudget: (status) => expect(status).toBeLessThan(500),
    });
  });

  it("reports each route's own max rather than the global default", async () => {
    // The global bucket is a separate, looser budget. A per-route response that
    // advertised the global max would mean `rateLimited()` never reached the
    // route declaration.
    const challenge = await post({
      url: "/auth/challenge",
      payload: { account: Keypair.random().publicKey() },
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.headers[LIMIT_HEADER]).toBe(String(policies.authChallenge.max));
    expect(challenge.headers[LIMIT_HEADER]).not.toBe(String(policies.global.max));

    const verify = await post({ url: "/auth/verify", payload: {} });
    expect(verify.headers[LIMIT_HEADER]).toBe(String(policies.authVerify.max));
    expect(verify.headers[LIMIT_HEADER]).not.toBe(String(policies.global.max));
  });

  it("keeps the challenge and verify budgets independent", async () => {
    const account = Keypair.random().publicKey();

    // Spend the whole challenge budget...
    await exhaust({
      url: "/auth/challenge",
      payload: { account },
      max: policies.authChallenge.max,
      expectInBudget: (status) => expect(status).toBe(200),
    });

    // ...then confirm verification still has its own untouched budget: a client
    // hammering challenge generation must not be able to lock out logins.
    const verify = await post({ url: "/auth/verify", payload: {} });
    expect(verify.statusCode).not.toBe(429);
    expect(verify.headers[LIMIT_HEADER]).toBe(String(policies.authVerify.max));
    expect(verify.headers[REMAINING_HEADER]).toBe(
      String(policies.authVerify.max - 1)
    );
  });

  it("keys the auth buckets by client IP, not by a shared bucket", async () => {
    const account = Keypair.random().publicKey();
    const attackerIp = "203.0.113.9";
    const otherIp = "198.51.100.4";

    await exhaust({
      url: "/auth/challenge",
      payload: { account },
      max: policies.authChallenge.max,
      remoteAddress: attackerIp,
      expectInBudget: (status) => expect(status).toBe(200),
    });

    // A different client still has a full, independent budget — one noisy IP
    // must not exhaust the challenge allowance for everyone else.
    const other = await post({
      url: "/auth/challenge",
      payload: { account },
      remoteAddress: otherIp,
    });
    expect(other.statusCode).toBe(200);
    expect(other.headers[REMAINING_HEADER]).toBe(
      String(policies.authChallenge.max - 1)
    );
  });
});
