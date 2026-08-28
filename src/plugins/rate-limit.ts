/**
 * Rate limiting.
 *
 * The per-route tiers live in `src/lib/rate-limit.ts`; this plugin registers
 * the limiter itself and sets the defaults every tier inherits. Two of those
 * defaults matter beyond the numbers:
 *
 *  - **Response headers.** A client that cannot see its own budget can only
 *    discover a limit by hitting it. `RateLimit-Limit` / `RateLimit-Remaining`
 *    / `RateLimit-Reset` are returned on every reply, and `Retry-After` on a
 *    429, so a well-behaved caller can pace itself instead of backing off
 *    blindly after a rejection.
 *  - **The global bucket's key.** The global limit is keyed like the named
 *    policies rather than by raw IP, so requests from one authenticated user
 *    share a budget wherever they connect from, and unauthenticated traffic
 *    still falls back to the resolved client IP.
 */
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config";
import { policyKeyGenerator, rateLimitPolicies } from "../lib/rate-limit";

export default fp(async function rateLimitPlugin(app) {
  const global = rateLimitPolicies().global;

  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
    keyGenerator: policyKeyGenerator(global),
    // The IETF draft names (`ratelimit-limit`, `ratelimit-remaining`,
    // `ratelimit-reset`) rather than the older `x-`-prefixed form.
    enableDraftSpec: true,
    addHeaders: {
      "ratelimit-limit": true,
      "ratelimit-remaining": true,
      "ratelimit-reset": true,
      "retry-after": true,
    },
  });
});
