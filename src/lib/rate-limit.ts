/**
 * Per-route rate-limit policies.
 *
 * Routes never spell out `max` / `timeWindow` / `keyGenerator` inline. They
 * name a policy from this table and spread the result into their Fastify route
 * options, so there is exactly one place where a limit's numbers, its bucket
 * key, and the hook it runs on are decided:
 *
 *   app.post("/settlements/:id/confirm", rateLimited("settlementConfirm"), handler)
 *
 * Every policy gets its own key *prefix*, which is what makes the buckets
 * independent: two routes with the same identity still consume separate
 * budgets, and a read route with no policy only ever touches the global one.
 *
 * Keying rules (see src/services/rate-limit-keys.ts):
 *  - `user-or-ip` — the authenticated Mergepay user id when the request has
 *    one, otherwise the resolved client IP. Requires the limiter to run on
 *    `preHandler`, after the route's `authenticate` hook has populated
 *    `req.user`; policies that need it declare `hook: "preHandler"`.
 *  - `ip` — strictly the client IP, for routes that have no authenticated user
 *    yet (SEP-10) or are authenticated by a shared secret (anchor webhook).
 *
 * Authenticated buckets use the SEP-10 public key so separate wallets cannot
 * exhaust one another's sensitive-route budget.
 */
import type { FastifyContextConfig } from "fastify";
import { config } from "../config";
import { ipKey, userOrIpKey } from "../services/rate-limit-keys";

/** The options object @fastify/rate-limit expects inside a route's config. */
export type RouteRateLimitOptions = Exclude<
  NonNullable<FastifyContextConfig["rateLimit"]>,
  false
>;

/** Keep operational health checks and public API documentation available. */
export function isGlobalRateLimitExempt(request: { url: string }): boolean {
  const path = request.url.split("?", 1)[0];
  return (
    path === "/health" ||
    path.startsWith("/health/") ||
    path === "/docs" ||
    path.startsWith("/docs/")
  );
}

export type RateLimitPolicyName =
  | "global"
  | "authChallenge"
  | "authVerify"
  | "expenseCreate"
  | "settlementCreate"
  | "settlementConfirm"
  | "settlementExecute"
  | "treasurySubmit"
  | "treasuryPropose"
  | "anchorInit"
  | "anchorPoll"
  | "anchorWebhook"
  | "sep24Callback"
  | "sep24Webhook"
  | "groupCreate"
  | "history";

export interface RateLimitPolicy {
  /** Requests permitted per window. */
  max: number;
  /** Window length in milliseconds. */
  timeWindow: number;
  /** Which identity the bucket is keyed by. */
  keyBy: "user-or-ip" | "ip";
  /** Key prefix — this is what keeps each policy's bucket independent. */
  prefix: string;
  /**
   * Fastify lifecycle hook the limiter runs on. `preHandler` is required for
   * `user-or-ip` policies so the authenticated user is already resolved;
   * `onRequest` (the plugin default) rejects earlier and is used elsewhere.
   */
  hook: "onRequest" | "preHandler";
}

/**
 * The policy table. Built lazily from `config` so tests can re-read it after
 * overriding environment variables.
 */
export function rateLimitPolicies(): Record<RateLimitPolicyName, RateLimitPolicy> {
  return {
    global: {
      max: config.RATE_LIMIT_GLOBAL_MAX,
      timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "global",
      hook: "onRequest",
    },
    authChallenge: {
      max: config.RATE_LIMIT_AUTH_CHALLENGE_MAX,
      timeWindow: config.RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS,
      keyBy: "ip",
      prefix: "auth.challenge",
      hook: "onRequest",
    },
    authVerify: {
      max: config.RATE_LIMIT_AUTH_VERIFY_MAX,
      timeWindow: config.RATE_LIMIT_AUTH_VERIFY_WINDOW_MS,
      keyBy: "ip",
      prefix: "auth.verify",
      hook: "onRequest",
    },
    // Its own bucket, keyed by the authenticated user. Expense creation is the
    // write that opens an obligation for every other participant, so it is
    // budgeted separately from the settlement routes that later close it: a
    // client retrying a settlement cannot spend the allowance guarding expense
    // creation, and vice versa.
    expenseCreate: {
      max: config.RATE_LIMIT_EXPENSE_CREATE_MAX,
      timeWindow: config.RATE_LIMIT_EXPENSE_CREATE_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "expense.create",
      hook: "preHandler",
    },
    settlementCreate: {
      max: config.RATE_LIMIT_SETTLEMENT_CREATE_MAX,
      timeWindow: config.RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "settlement.create",
      hook: "preHandler",
    },
    settlementConfirm: {
      max: config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX,
      timeWindow: config.RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "settlement.confirm",
      hook: "preHandler",
    },
    // Its own bucket rather than sharing settlementConfirm's: execution is the
    // endpoint clients retry after a network timeout, so its budget has to
    // absorb legitimate retries without spending the confirm budget too.
    settlementExecute: {
      max: config.RATE_LIMIT_SETTLEMENT_EXECUTE_MAX,
      timeWindow: config.RATE_LIMIT_SETTLEMENT_EXECUTE_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "settlement.execute",
      hook: "preHandler",
    },
    treasurySubmit: {
      max: config.RATE_LIMIT_TREASURY_SUBMIT_MAX,
      timeWindow: config.RATE_LIMIT_TREASURY_SUBMIT_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "treasury.submit",
      hook: "preHandler",
    },
    treasuryPropose: {
      max: config.RATE_LIMIT_TREASURY_PROPOSE_MAX,
      timeWindow: config.RATE_LIMIT_TREASURY_PROPOSE_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "treasury.propose",
      hook: "preHandler",
    },
    anchorInit: {
      max: config.RATE_LIMIT_ANCHOR_INIT_MAX,
      timeWindow: config.RATE_LIMIT_ANCHOR_INIT_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "anchor.init",
      hook: "preHandler",
    },
    anchorPoll: {
      max: config.RATE_LIMIT_ANCHOR_POLL_MAX,
      timeWindow: config.RATE_LIMIT_ANCHOR_POLL_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "anchor.poll",
      hook: "preHandler",
    },
    anchorWebhook: {
      max: config.RATE_LIMIT_ANCHOR_WEBHOOK_MAX,
      timeWindow: config.RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS,
      keyBy: "ip",
      prefix: "anchor.webhook",
      hook: "onRequest",
    },
    // The two SEP-24 callback surfaces. Both are unauthenticated until their own
    // credential is checked (a shared HMAC secret, and a SEP-10 anchor token
    // respectively) and both are keyed by IP for the same reason, but they get
    // separate buckets: an anchor that saturates the token-authenticated
    // callback must not also throttle secret-authenticated callbacks.
    sep24Callback: {
      max: config.SEP24_RATE_LIMIT_MAX,
      timeWindow: config.SEP24_RATE_LIMIT_WINDOW_MS,
      keyBy: "ip",
      prefix: "sep24.callback",
      hook: "onRequest",
    },
    sep24Webhook: {
      max: config.SEP24_RATE_LIMIT_MAX,
      timeWindow: config.SEP24_RATE_LIMIT_WINDOW_MS,
      keyBy: "ip",
      prefix: "sep24.webhook",
      hook: "onRequest",
    },
    groupCreate: {
      max: config.RATE_LIMIT_GROUP,
      timeWindow: config.RATE_LIMIT_GROUP_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "group.create",
      hook: "preHandler",
    },
    history: {
      max: config.RATE_LIMIT_HISTORY,
      timeWindow: config.RATE_LIMIT_HISTORY_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "history.read",
      hook: "preHandler",
    },
  };
}

/** Resolve a policy's key generator. */
export function policyKeyGenerator(policy: RateLimitPolicy) {
  return policy.keyBy === "ip" ? ipKey(policy.prefix) : userOrIpKey(policy.prefix);
}

/**
 * Route options applying a named policy, e.g.
 * `app.post("/auth/verify", rateLimited("authVerify"), handler)`.
 *
 * The returned object also carries `rateLimitPolicy` — the policy's name,
 * alongside `rateLimit` rather than inside it, so @fastify/rate-limit never
 * sees it. It exists so the wiring can be audited: tests/rate-limit-wiring
 * reads it back off every registered route to assert both that no route
 * hand-rolls its numbers and that no policy in the table is declared without
 * being applied. A table entry nothing routes name is a limit an operator can
 * tune with no effect, which is exactly the failure this marker makes loud.
 */
export function rateLimited(name: Exclude<RateLimitPolicyName, "global">) {
  const policy = rateLimitPolicies()[name];
  return {
    config: {
      rateLimitPolicy: name,
      rateLimit: {
        max: policy.max,
        timeWindow: policy.timeWindow,
        hook: policy.hook,
        keyGenerator: policyKeyGenerator(policy),
        onExceeded: (req: any, key: string) => {
          req.log?.warn?.(
            { key, policy: name, ip: req.ip, route: req.url },
            `Rate limit exceeded for policy ${name}`
          );
        },
      },
    },
  };
}
