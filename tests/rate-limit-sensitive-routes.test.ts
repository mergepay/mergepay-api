/**
 * Rate limiting for sensitive authentication/payment endpoints.
 *
 * The per-route policies live in src/lib/rate-limit.ts and are exercised in
 * synthetic Fastify apps elsewhere (tests/rateLimit.test.ts,
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
    // A row complete enough for serializeGroup, so POST /groups reaches 200 and
    // the suite is measuring the limiter rather than the mock's shape.
    group: {
      ...model(),
      create: vi.fn(async () => ({
        id: "group_rate_limit_test",
        name: "Rate limit test group",
        description: null,
        createdByUserId: "user_rate_limit_test",
        treasuryEnabled: false,
        treasuryAccountPublicKey: null,
        treasuryRequiredSigners: null,
        archived: false,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      })),
    },
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
    withdrawal: model(),
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
import {
  Account,
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { config } from "../src/config";

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

function signedXdr(): string {
  const signer = Keypair.random();
  const transaction = new TransactionBuilder(new Account(signer.publicKey(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.manageData({ name: "rate-limit-test", value: "signed" }))
    .setTimeout(60)
    .build();
  transaction.sign(signer);
  return transaction.toXDR();
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

describe("rate limiting on the real app wiring", () => {
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
      payload: { signedXdr: signedXdr() },
      label: "treasury-transactions/:id/confirm",
    });
  });

  it("POST /groups — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.groupCreate.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/groups",
      max,
      headers: authHeader(),
      payload: { name: "Rate limit test group" },
      label: "groups",
    });
  });

  it("GET /history — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.history.max;
    await exhaustAndAssert({
      method: "GET",
      url: "/history",
      max,
      headers: authHeader(),
      label: "history",
    });
  });

  it("POST /anchors/webhook — per-route budget, headers, and 429 envelope", async () => {
    // IP-keyed, like the SEP-10 buckets: the anchor has no Mergepay session.
    // An unsigned body is rejected by the shared-secret check, which is what
    // the limiter runs ahead of.
    const max = policies.anchorWebhook.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/anchors/webhook",
      max,
      payload: {},
      label: "anchors/webhook",
    });
  });

  it("POST /withdraw — per-route budget, headers, and 429 envelope", async () => {
    // On-chain payment submission (issues #363 / #403): withdrawal
    // initiation shares the tight anchor-init budget. Malformed bodies fail
    // body validation before any anchor call, so the suite measures the
    // limiter itself.
    const max = policies.anchorInit.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/withdraw",
      max,
      headers: authHeader(),
      payload: {},
      label: "withdraw",
    });
  });

  it("POST /withdraw/:id/confirm — per-route budget, headers, and 429 envelope", async () => {
    // The signed-XDR submission step of a withdrawal: budgeted with the
    // other payment confirmations so retrying a submission cannot exhaust a
    // caller's global allowance.
    const max = policies.settlementConfirm.max;
    await exhaustAndAssert({
      method: "POST",
      url: "/withdraw/wth_rate_limit/confirm",
      max,
      headers: authHeader(),
      payload: { signedXdr: signedXdr() },
      label: "withdraw/:id/confirm",
    });
  });

  it("exhausting a submission budget leaves the global bucket untouched", async () => {
    // `POST /groups` and `GET /history` used to hand-write
    // `config: { rateLimit: { max, timeWindow } }`. @fastify/rate-limit merges
    // such a route's options onto the *global* ones, so the route silently
    // inherited the global keyGenerator and counted against the global counter:
    // creating 10 groups spent 10 of the caller's 100 global requests, and
    // unrelated global traffic could 429 a route that had spent nothing of its
    // own. Both now name a policy with its own key prefix.
    // One identity for the whole exchange: `authHeader()` mints a fresh
    // SEP-10 public key per call, and a user-keyed policy gives each wallet its
    // own budget.
    const headers = authHeader();
    const groupMax = policies.groupCreate.max;
    for (let i = 0; i < groupMax; i++) {
      await app.inject({
        method: "POST",
        url: "/groups",
        headers,
        payload: { name: "Shared bucket test" },
      });
    }
    const blocked = await app.inject({
      method: "POST",
      url: "/groups",
      headers,
      payload: { name: "Shared bucket test" },
    });
    expect(blocked.statusCode).toBe(429);

    // A different policy keeps its own budget...
    const otherPolicy = await app.inject({
      method: "GET",
      url: "/history",
      headers,
    });
    expect(otherPolicy.statusCode).not.toBe(429);

    // ...and so does the global bucket, which /me is subject to.
    const global = await app.inject({ method: "GET", url: "/me", headers });
    expect(global.statusCode).not.toBe(429);
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

/**
 * Issue #518 — expense creation is a sensitive financial write and needed its
 * own per-identity budget.
 *
 * The SEP-10 auth and settlement routes were already bounded (issues #538 and
 * #581), but `POST /groups/:id/expenses` — the write that opens a debt for
 * every other participant — had no per-route policy and fell back to the
 * blanket global allowance, which no single caller can exhaust on their own.
 *
 * These cases drive the real app through `buildApp()`, so they fail if the
 * `rateLimited("expenseCreate")` annotation is ever dropped from the route
 * declaration, and they pin the three properties the issue asks for: a
 * dedicated budget, the standard headers and 429 envelope, and per-user keys
 * taken from the SEP-10 token rather than the shared client address.
 */
describe("expense creation rate limiting (#518)", () => {
  /** A stable token per user id, so one user's bucket is reused across calls. */
  function tokenFor(userId: string) {
    const token = signToken({
      id: userId,
      stellarPublicKey: Keypair.random().publicKey(),
    });
    return { authorization: `Bearer ${token}` };
  }

  const groupUrl = "/groups/00000000-0000-0000-0000-000000000000/expenses";

  /**
   * A body the route's own Zod schema accepts.
   *
   * This matters: Fastify validates the body before any `preHandler` runs, and
   * the limiter is a `preHandler` policy. A malformed body is therefore
   * rejected at 400 without ever touching the budget, so a test that spends the
   * budget has to send a well-formed expense.
   */
  function expenseBody(userId: string) {
    return {
      title: "Rate limit test expense",
      amount: "10.0000000",
      assetCode: "XLM",
      splitType: "equal",
      shares: [{ userId }],
    };
  }

  it("carries its own budget rather than the global allowance", () => {
    const policy = policies.expenseCreate;
    // A dedicated policy, not a copy of the global numbers: a distinct
    // keying mode, its own bucket prefix, and a preHandler hook so the
    // authenticated user is resolved before the key is computed.
    expect(policy.keyBy).toBe("user-or-ip");
    expect(policy.hook).toBe("preHandler");
    expect(policy.prefix).toBe("expense.create");
    expect(policy.max).toBe(config.RATE_LIMIT_EXPENSE_CREATE_MAX);
    expect(policy.timeWindow).toBe(config.RATE_LIMIT_EXPENSE_CREATE_WINDOW_MS);
    // Strictly tighter than the blanket allowance it replaces.
    expect(policy.max).toBeLessThan(policies.global.max);
  });

  it("POST /groups/:id/expenses — per-route budget, headers, and 429 envelope", async () => {
    const max = policies.expenseCreate.max;
    const userId = "user_518_primary";
    const headers = tokenFor(userId);
    const blocked = await exhaustAndAssert({
      method: "POST",
      url: groupUrl,
      max,
      headers,
      payload: expenseBody(userId),
      label: "groups/:id/expenses",
    });
    // The advertised limit is this policy's, not the global default — proof
    // the route is wired to `expenseCreate` and not merely inheriting global.
    expect(blocked.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(blocked.headers["x-ratelimit-limit"]).not.toBe(String(policies.global.max));
  });

  it("keys the bucket by the SEP-10 identity, not the client address", async () => {
    const max = policies.expenseCreate.max;
    const noisyId = "user_518_noisy";
    const noisy = tokenFor(noisyId);
    const neighbour = tokenFor("user_518_neighbour");

    // Same client address, same route, same instant — only the token differs.
    for (let i = 0; i < max; i++) {
      const res = await app.inject({
        method: "POST",
        url: groupUrl,
        headers: noisy,
        payload: expenseBody(noisyId),
      });
      expect(res.statusCode, `noisy request ${i + 1}`).not.toBe(429);
    }
    const blocked = await app.inject({
      method: "POST",
      url: groupUrl,
      headers: noisy,
      payload: expenseBody(noisyId),
    });
    expect(blocked.statusCode).toBe(429);

    // A different wallet behind the same NAT must not inherit the exhausted
    // budget, otherwise one noisy member locks out the whole group.
    const other = await app.inject({
      method: "POST",
      url: groupUrl,
      headers: neighbour,
      payload: expenseBody("user_518_neighbour"),
    });
    expect(other.statusCode).not.toBe(429);
    expect(other.headers["x-ratelimit-limit"]).toBe(String(max));
    expect(other.headers["x-ratelimit-remaining"]).toBe(String(max - 1));
  });

  it("an unauthenticated caller cannot spend a member's budget", async () => {
    // `app.authenticate` is registered as an instance-level preHandler, so it
    // runs before the limiter's hook and an anonymous caller is turned away at
    // 401 without ever being counted. The policy's `user-or-ip` keying is
    // therefore never reached without an identity here, and no anonymous flood
    // can exhaust a signed-in member's allowance.
    const max = policies.expenseCreate.max;
    for (let i = 0; i < max + 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: groupUrl,
        payload: expenseBody("user_518_victim"),
      });
      expect(res.statusCode, `anonymous request ${i + 1}`).toBe(401);
    }

    const victimId = "user_518_victim";
    const victim = tokenFor(victimId);
    const first = await app.inject({
      method: "POST",
      url: groupUrl,
      headers: victim,
      payload: expenseBody(victimId),
    });
    expect(first.statusCode).not.toBe(429);
    expect(first.headers["x-ratelimit-remaining"]).toBe(String(max - 1));
  });

  it("does not spend the settlement budget, and is not spent by it", async () => {
    const max = policies.expenseCreate.max;
    const userId = "user_518_cross_policy";
    const headers = tokenFor(userId);

    // Exhaust expense creation for this identity.
    for (let i = 0; i < max; i++) {
      await app.inject({ method: "POST", url: groupUrl, headers, payload: expenseBody(userId) });
    }
    expect(
      (await app.inject({ method: "POST", url: groupUrl, headers, payload: expenseBody(userId) }))
        .statusCode
    ).toBe(429);

    // Settlement creation has its own prefix, so the same user still has a full
    // budget there: exhausting one write must not lock the other.
    const settlement = await app.inject({
      method: "POST",
      url: "/groups/00000000-0000-0000-0000-000000000000/settlements",
      headers,
      payload: {},
    });
    expect(settlement.statusCode).not.toBe(429);
    expect(settlement.headers["x-ratelimit-limit"]).toBe(
      String(policies.settlementCreate.max)
    );
  });

  it("reads routes are untouched by the expense creation budget", async () => {
    const max = policies.expenseCreate.max;
    const userId = "user_518_reads";
    const headers = tokenFor(userId);
    for (let i = 0; i < max; i++) {
      await app.inject({ method: "POST", url: groupUrl, headers, payload: expenseBody(userId) });
    }
    // Listing expenses is a read and keeps the generous general-read budget.
    const list = await app.inject({ method: "GET", url: groupUrl, headers });
    expect(list.statusCode).not.toBe(429);
  });
});
