/**
 * Per-route rate-limit policies.
 *
 * Routes name a policy instead of repeating its limits, bucket key, and hook.
 * Each policy has an independent prefix so one route cannot consume another's
 * budget. Authenticated policies run after authentication; SEP-10 and webhook
 * policies are keyed by client IP.
 */
import type { FastifyContextConfig } from "fastify";
import type {} from "@fastify/rate-limit";
import { config } from "../config";
import { ipKey, userOrIpKey } from "../services/rate-limit-keys";

export type RateLimitPolicyName =
  | "global"
  | "authChallenge"
  | "authVerify"
  | "settlementCreate"
  | "settlementConfirm"
  | "settlementExecute"
  | "treasurySubmit"
  | "treasuryPropose"
  | "anchorInit"
  | "anchorPoll"
  | "anchorWebhook"
  | "groupCreate"
  | "history";

export interface RateLimitPolicy {
  max: number;
  timeWindow: number;
  keyBy: "user-or-ip" | "ip";
  prefix: string;
  hook: "onRequest" | "preHandler";
}

export type RouteRateLimitOptions = Exclude<
  NonNullable<FastifyContextConfig["rateLimit"]>,
  false
>;

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

export function policyKeyGenerator(policy: RateLimitPolicy) {
  return policy.keyBy === "ip" ? ipKey(policy.prefix) : userOrIpKey(policy.prefix);
}

export function rateLimited(name: Exclude<RateLimitPolicyName, "global">) {
  const policy = rateLimitPolicies()[name];
  const rateLimitOptions = {
    max: policy.max,
    timeWindow: policy.timeWindow,
    hook: policy.hook,
    keyGenerator: policyKeyGenerator(policy),
  } satisfies RouteRateLimitOptions;

  return { config: { rateLimit: rateLimitOptions } };
}