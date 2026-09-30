/**
 * Rate limiting — the single registration point for @fastify/rate-limit.
 *
 * The per-route tiers live in `src/lib/rate-limit.ts`; this plugin registers
 * the limiter itself and sets the defaults every tier inherits. Four of those
 * defaults matter beyond the numbers:
 *
 *  - **Response headers.** A client that cannot see its own budget can only
 *    discover a limit by hitting it. `X-RateLimit-Limit` / `X-RateLimit-Remaining`
 *    / `X-RateLimit-Reset` are returned on every reply, and `Retry-After` on a
 *    429, so a well-behaved caller can pace itself instead of backing off
 *    blindly after a rejection.
 *  - **The 429 body.** `errorResponseBuilder` must return a real `Error`, not a
 *    bare payload object. The plugin *throws* whatever this returns, and only
 *    Error instances engage the central error handler that stamps the
 *    requestId and renders the standard envelope — a plain object bypassed it
 *    entirely and surfaced as a 500 INTERNAL_ERROR with the 429 headers already
 *    attached, which is precisely the incoherence this builder exists to avoid.
 *  - **The global bucket's key.** The global limit is keyed from the bearer
 *    token rather than by raw IP, so requests from one authenticated user share
 *    a budget wherever they connect from, and unauthenticated traffic still
 *    falls back to the resolved client IP.
 *  - **The counter store.** `RATE_LIMIT_STORE=database` shares counters across
 *    instances via Postgres; it is wired here and nowhere else, so the env var
 *    is a real switch rather than a documented no-op.
 */
import type { FastifyContextConfig, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config";
import { AppError, ErrorCode } from "../lib/errors";
import { isGlobalRateLimitExempt } from "../lib/rate-limit";
import { PrismaRateLimitStore } from "../services/rate-limit-store";
import { verifyToken } from "./auth";

/**
 * The subset of the plugin's options the `RATE_LIMIT_STORE` switch sets.
 *
 * Derived from the `fastify` module augmentation @fastify/rate-limit installs
 * rather than restated, so the two cannot drift. The package exports its option
 * types through `export =`, which gives no importable name for them.
 */
type RateLimitStoreOptions = Pick<
  Exclude<NonNullable<FastifyContextConfig["rateLimit"]>, false>,
  "store" | "skipOnError"
>;

/**
 * Tiered rate-limit thresholds for public auth endpoints vs authenticated routes.
 */
export const RATE_LIMIT_TIERS = {
  publicAuth: {
    max: config.RATE_LIMIT_AUTH_VERIFY_MAX,
    timeWindow: config.RATE_LIMIT_AUTH_VERIFY_WINDOW_MS,
  },
  authenticated: {
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
  },
} as const;

/**
 * Global-policy key. Unlike the per-route policies (which run on `preHandler`
 * and can read `req.user`), the global limiter runs on `onRequest`, before any
 * route's authenticate hook, so it resolves the identity from the bearer token
 * itself. An unparseable token deliberately falls back to the client IP so
 * invalid credentials share one bucket instead of minting a fresh one each try.
 */
export function globalRateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    try {
      const user = verifyToken(authorization.slice("Bearer ".length).trim());
      return `global:user:${user.id}`;
    } catch {
      // Invalid credentials are deliberately grouped by client IP.
    }
  }
  return `global:ip:${request.ip}`;
}

/**
 * Custom key generator identifying authenticated user identity from JWT or falling back to IP.
 */
export function authenticatedOrIpKey(prefix: string) {
  return (req: FastifyRequest): string => {
    const authorization = req.headers.authorization;
    if (authorization?.startsWith("Bearer ")) {
      try {
        const user = verifyToken(authorization.slice("Bearer ".length).trim());
        return `${prefix}:user:${user.id}`;
      } catch {
        // Fall back to client IP for unauthenticated / invalid token
      }
    }
    return `${prefix}:ip:${req.ip}`;
  };
}

/**
 * Counter store for a given `RATE_LIMIT_STORE` setting.
 *
 * The database store keeps counts shared across instances but adds a query per
 * request and depends on the `rate_limit_buckets` table. It also fails OPEN
 * (`skipOnError`): a database hiccup must degrade to "unlimited" rather than
 * turning every route into a 500. The default "memory" store is per-process,
 * needs no failure handling, and adds no per-request query.
 *
 * Exported so the choice can be asserted directly; the registration below is
 * the only place it is applied.
 */
export function rateLimitStoreOptions(store: string): RateLimitStoreOptions {
  if (store === "database") {
    return { store: PrismaRateLimitStore, skipOnError: true };
  }
  return {};
}

export default fp(async function rateLimitPlugin(app) {
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
    keyGenerator: globalRateLimitKey,
    // Health checks and the OpenAPI docs stay reachable during an incident.
    allowList: isGlobalRateLimitExempt,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
    ...rateLimitStoreOptions(config.RATE_LIMIT_STORE),
    // Must be a real Error (AppError), not a bare payload object — see the
    // module comment above. (The builder's request argument is intentionally
    // unused: the error handler owns the requestId.)
    errorResponseBuilder: () =>
      new AppError(429, ErrorCode.RATE_LIMITED, "Too many requests. Please retry later."),
  });
});
