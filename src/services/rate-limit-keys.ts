/**
 * Rate-limit key generators shared across routes.
 *
 * Keys are always bounded in length and use the authenticated Stellar public
 * key for user-scoped limits, or the client's network address. `req.ip` is Fastify's own resolved address;
 * it respects the `trustProxy` option configured on the Fastify server, which
 * should only be enabled when the operator populates TRUSTED_PROXY_IPS.
 */
import type { FastifyRequest } from "fastify";
import { config } from "../config";

const MAX_KEY_LENGTH = 200;

function normalizeIp(ip: string | undefined): string {
  return (ip && ip.length > 0 ? ip : "unknown").slice(0, MAX_KEY_LENGTH);
}

function bound(key: string): string {
  return key.slice(0, MAX_KEY_LENGTH);
}

/** Parse trusted proxy IPs into a Set for O(1) lookups. */
function trustedProxySet(): Set<string> {
  return new Set(
    config.TRUSTED_PROXY_IPS
      .split(",")
      .map((ip) => ip.trim())
      .filter((ip) => ip.length > 0)
  );
}

/** Key by the authenticated user when available, otherwise by client IP. */
export function userOrIpKey(prefix: string) {
  return (req: FastifyRequest): string => {
    // Some authenticated request contexts expose the internal user id before
    // the SEP-10 public key is attached. Treat either stable identity as a
    // user-scoped bucket; falling back to IP must only happen anonymously.
    const userKey = req.user?.stellarPublicKey ?? req.user?.id;
    const ip = normalizeIp(req.ip);
    if (userKey) {
      return bound(`${prefix}:public-key:${userKey}`);
    }
    return bound(`${prefix}:ip:${ip}`);
  };
}

/** Key strictly by client IP — for routes with no authenticated user yet. */
export function ipKey(prefix: string) {
  return (req: FastifyRequest): string => {
    const ip = normalizeIp(req.ip);
    return bound(`${prefix}:ip:${ip}`);
  };
}
