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
 * A key never contains a Stellar public key, so a 429 can't be used to probe
 * whether a given wallet account is known to the API.
 */
import { config } from "../config";
import { ipKey, userOrIpKey } from "../services/rate-limit-keys";

export type RateLimitPolicyName =
  | "global"
  | "authChallenge"
  | "authVerify"
  | "settlementCreate"
  | "settlementConfirm"
  | "treasurySubmit"
  | "treasuryPropose"
  | "anchorInit"
  | "anchorPoll"
  | "anchorWebhook"
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
    groupCreate: {
      max: config.RATE_LIMIT_GROUP,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
      keyBy: "user-or-ip",
      prefix: "group.create",
      hook: "preHandler",
    },
    history: {
      max: config.RATE_LIMIT_HISTORY,
      timeWindow: config.RATE_LIMIT_WINDOW_MS,
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
 */
export function rateLimited(name: Exclude<RateLimitPolicyName, "global">) {
  const policy = rateLimitPolicies()[name];
  return {
    config: {
      rateLimit: {
        max: policy.max,
        timeWindow: policy.timeWindow,
        hook: policy.hook,
        keyGenerator: policyKeyGenerator(policy),
      },
    },
  };
}
