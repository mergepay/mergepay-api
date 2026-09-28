/**
 * Issue #346 — rate-limit wiring audit.
 *
 * The policy table in src/lib/rate-limit.ts can be correct and the server can
 * still be effectively unlimited: what matters is which routes actually name a
 * policy, and whether the limiter they inherit is the one the table describes.
 * This suite reads the registered routes back off a real `buildApp()` instance
 * and asserts the wiring, which is the class of defect unit tests over the
 * policy table structurally cannot see.
 *
 * Three defects it exists to prevent, all of which shipped at some point:
 *
 *  1. A route that hand-writes `config: { rateLimit: { max, timeWindow } }`.
 *     @fastify/rate-limit merges route options onto the *global* ones, so such
 *     a route silently inherits `keyGenerator: globalRateLimitKey` — the very
 *     key the global bucket counts. `POST /groups` and `GET /history` were
 *     written that way, which made their budgets non-independent: a caller
 *     burning its group-creation budget also burned 10 of its 100 global
 *     requests, and unrelated global traffic could 429 a route that had spent
 *     nothing of its own.
 *  2. A policy declared in the table that no route names. `RATE_LIMIT_GROUP`,
 *     `RATE_LIMIT_HISTORY`, and `RATE_LIMIT_ANCHOR_WEBHOOK_MAX` were all
 *     documented tunables that nothing read, so an operator could raise or
 *     lower them and see no change.
 *  3. Two policy tables. src/config/ratelimit.ts was a near-copy of
 *     src/lib/rate-limit.ts that no module imported — except the test suite,
 *     which therefore asserted against code the server never ran.
 *
 * `onRoute` fires while the route plugins load, and buildApp exposes that hook
 * through `BuildAppOptions.onRoute` because a hook attached to the returned
 * instance would be too late — the plugins are already loaded by then.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "../src/app";
import {
  rateLimitPolicies,
  type RateLimitPolicy,
  type RateLimitPolicyName,
} from "../src/lib/rate-limit";

interface RegisteredRoute {
  method: string;
  url: string;
  policy?: string;
  rateLimit?: Record<string, any>;
}

let routes: RegisteredRoute[] = [];
let policies: Record<RateLimitPolicyName, RateLimitPolicy>;

function describeRoute(route: RegisteredRoute) {
  return `${route.method} ${route.url}`;
}

beforeAll(async () => {
  policies = rateLimitPolicies();
  // Deliberately not closed: the static-file plugin and the Prisma pool keep
  // handles open, and this suite holds no request-level state to release.
  await buildApp({
    onRoute: (routeOptions) => {
      const config = (routeOptions.config ?? {}) as Record<string, any>;
      // `method` is a bare string for a normal `app.post(...)` and an array
      // only for `app.all(...)`. Calling `.join` on the string form throws, and
      // a throwing onRoute hook leaves Fastify's boot promise pending rather
      // than rejecting — the suite then dies as a hook timeout.
      const { method } = routeOptions;
      routes.push({
        method: Array.isArray(method) ? method.join(",") : String(method ?? ""),
        url: routeOptions.url ?? "",
        policy: config.rateLimitPolicy,
        rateLimit: config.rateLimit,
      });
    },
  });
});

describe("rate-limit registration options", () => {
  it("registers every route, so the audit below is looking at the real route table", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.some((r) => r.url === "/auth/challenge")).toBe(true);
    expect(routes.some((r) => r.url === "/settlements/:id/confirm")).toBe(true);
  });
});

describe("no route hand-rolls its rate-limit numbers", () => {
  it("every route that declares a limit names a policy from the table", () => {
    const handRolled = routes
      .filter((route) => route.rateLimit !== undefined && route.policy === undefined)
      .map(describeRoute);

    expect(handRolled).toEqual([]);
  });

  it("every named policy actually exists in the table", () => {
    const unknown = routes
      .filter((route) => route.policy !== undefined)
      .map((route) => route.policy as string)
      .filter((name) => !(name in policies));

    expect([...new Set(unknown)]).toEqual([]);
  });

  it("a named policy's numbers are the ones the table declares", () => {
    // Guards against a route spreading a policy and then overriding `max`,
    // which would leave the table describing a limit nothing enforces.
    const drifted = routes
      .filter((route) => route.policy !== undefined)
      .filter((route) => {
        const policy = policies[route.policy as RateLimitPolicyName];
        const applied = route.rateLimit ?? {};
        return (
          applied.max !== policy.max ||
          applied.timeWindow !== policy.timeWindow ||
          applied.hook !== policy.hook
        );
      })
      .map(describeRoute);

    expect(drifted).toEqual([]);
  });

  it("user-keyed policies run on preHandler, so authenticate has resolved the user first", () => {
    // On `onRequest` the limiter cannot read `req.user`; every such policy would
    // silently fall back to keying by IP, which lets one client exhaust a
    // budget the table intends to share across a user's devices.
    for (const route of routes) {
      const policy = policies[route.policy as RateLimitPolicyName];
      if (policy?.keyBy !== "user-or-ip") continue;
      expect({ route: describeRoute(route), hook: route.rateLimit?.hook }).toEqual({
        route: describeRoute(route),
        hook: "preHandler",
      });
    }
  });
});

describe("no policy is declared without being applied", () => {
  it("every policy in the table is named by at least one route", () => {
    const used = new Set(
      routes.map((route) => route.policy).filter((name): name is string => !!name)
    );
    const orphans = (Object.keys(policies) as RateLimitPolicyName[]).filter(
      (name) => name !== "global" && !used.has(name)
    );

    expect(orphans).toEqual([]);
  });
});

describe("sensitive routes carry the tighter per-route budget", () => {
  const expected: Array<[string, string, RateLimitPolicyName]> = [
    // SEP-10. Keyed by IP: there is no session yet, and a public-key bucket
    // would make 429s an oracle for whether an account is known.
    ["POST", "/auth/challenge", "authChallenge"],
    ["POST", "/auth/verify", "authVerify"],
    ["POST", "/auth/refresh", "authVerify"],
    // Expense creation writes a row and starts a payment split, so it is
    // budgeted on its own rather than drawing on the settlement budget.
    ["POST", "/groups/:id/expenses", "expenseCreate"],
    // Settlement submission and confirmation.
    ["POST", "/expenses/:id/settle", "settlementCreate"],
    ["POST", "/groups/:id/settlements", "settlementCreate"],
    ["POST", "/api/settlements/execute", "settlementExecute"],
    ["POST", "/settlements/:id/confirm", "settlementConfirm"],
    ["POST", "/groups/:id/treasury/deposit", "settlementCreate"],
    ["POST", "/groups/:id/treasury/withdraw", "settlementCreate"],
    // On-chain payment submission (issues #363 / #403): withdrawal initiation
    // fans out to the anchor like the other anchor-init routes, and the
    // confirmation submits a signed XDR like the other confirm routes.
    ["POST", "/withdraw", "anchorInit"],
    ["POST", "/withdraw/:id/confirm", "settlementConfirm"],
    ["POST", "/treasury-transactions/:id/confirm", "treasurySubmit"],
    // Treasury multisig: creating a proposal is bounded separately from adding
    // a signature to one.
    ["POST", "/api/treasury/proposals", "treasuryPropose"],
    ["POST", "/groups/:groupId/treasury/proposals", "treasuryPropose"],
    ["POST", "/api/treasury/proposals/:id/signatures", "treasurySubmit"],
    ["POST", "/groups/:groupId/treasury/proposals/:proposalId/sign", "treasurySubmit"],
    // Anchor / SEP-24. Initiation fans out upstream, so it is the tightest.
    ["POST", "/anchors/deposit", "anchorInit"],
    ["POST", "/anchors/withdraw", "anchorInit"],
    ["POST", "/anchors/sessions/:id/complete", "anchorInit"],
    ["POST", "/api/sep24/deposit", "anchorInit"],
    ["POST", "/api/sep24/withdraw", "anchorInit"],
    ["GET", "/anchors", "anchorPoll"],
    ["GET", "/anchors/sessions", "anchorPoll"],
    ["GET", "/anchors/sessions/:id", "anchorPoll"],
    ["POST", "/anchors/webhook", "anchorWebhook"],
    ["POST", "/api/sep24/callback", "sep24Callback"],
    ["POST", "/api/webhooks/sep24", "sep24Webhook"],
    // Group creation and history.
    ["POST", "/groups", "groupCreate"],
    ["GET", "/history", "history"],
  ];

  it("covers every route the application declares a limit on", () => {
    // The reverse direction: a policy applied to a route the table above does
    // not know about is a new surface, and belongs in the audited list.
    // Fastify's synthesised HEAD routes are excluded here and asserted
    // separately below.
    const listed = new Set(expected.map(([method, url]) => `${method} ${url}`));
    const unlisted = routes
      .filter((route) => route.policy !== undefined && route.method !== "HEAD")
      .map(describeRoute)
      .filter((route) => !listed.has(route));

    expect(unlisted).toEqual([]);
  });

  it("no HEAD route is a way around its GET route's budget", () => {
    // Fastify adds a HEAD route for every GET, copying the route options. If
    // the copy ever lost `config`, HEAD would answer from the global bucket
    // while GET answers from the per-route one.
    const heads = routes.filter((route) => route.method === "HEAD");
    expect(heads.length).toBeGreaterThan(0);

    for (const head of heads) {
      const get = routes.find((r) => r.method === "GET" && r.url === head.url);
      expect({ url: head.url, policy: head.policy }).toEqual({
        url: head.url,
        policy: get?.policy,
      });
    }
  });

  it.each(expected)("%s %s applies the %s policy", (method, url, policy) => {
    const route = routes.find((r) => r.method === method && r.url === url);
    expect(route, `route ${method} ${url} is not registered`).toBeDefined();
    expect(route?.policy).toBe(policy);
  });

  it("every sensitive budget is tighter than the global default", () => {
    for (const [method, url] of expected) {
      const route = routes.find((r) => r.method === method && r.url === url);
      expect(
        route?.rateLimit?.max,
        `${method} ${url} is not limited below the global default`
      ).toBeLessThan(policies.global.max);
    }
  });

  it("sensitive buckets stay independent of the global one", () => {
    // Two routes sharing a key prefix would share a counter, so burning one
    // budget would silently throttle the other.
    for (const [method, url, policy] of expected) {
      const route = routes.find((r) => r.method === method && r.url === url);
      expect(
        policies[policy].prefix,
        `${method} ${url} shares the global bucket`
      ).not.toBe(policies.global.prefix);
    }
  });
});
