/**
 * Rate-limit key generators shared across routes.
 *
 * Keys are always bounded in length and never include a Stellar public key
 * or other wallet identifier — only Mergepay's internal (cuid) user id, or
 * the client's network address. `req.ip` is Fastify's own resolved address;
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
    const userId = req.user?.id;
    const ip = normalizeIp(req.ip);
    if (userId) {
      return bound(`${prefix}:user:${userId}`);
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
