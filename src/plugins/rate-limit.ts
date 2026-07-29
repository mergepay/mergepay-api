import { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import rateLimit from "@fastify/rate-limit";
import { config } from "../config";

/**
 * Rate limit plugin with configurable limits from environment variables.
 * - Global default: 100 requests per minute
 * - Auth endpoints: 10 requests per minute
 * - Settlement confirm: 10 requests per minute
 *
 * 429 responses include Retry-After header.
 */
export default fp(async function rateLimitPlugin(app: FastifyInstance) {
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW,
    // No allowList bypass - rate limiting is active in all modes including tests
    addHeadersOnExceeding: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
    },
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });
});
