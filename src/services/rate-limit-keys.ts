/**
 * Rate-limit key generators shared across routes.
 *
 * Keys are always bounded in length and never include a Stellar public key
 * or other wallet identifier — only Mergepay's internal (cuid) user id, or
 * the client's network address. `req.ip` is Fastify's own resolved address;
 * it does not trust X-Forwarded-For unless the app is started with Fastify's
 * `trustProxy` option explicitly enabled by the operator; see README.
 */
import type { FastifyRequest } from "fastify";

const MAX_KEY_LENGTH = 200;

function normalizeIp(ip: string | undefined): string {
  return (ip && ip.length > 0 ? ip : "unknown").slice(0, MAX_KEY_LENGTH);
}

function bound(key: string): string {
  return key.slice(0, MAX_KEY_LENGTH);
}

/** Key by the authenticated user when available, otherwise by client IP. */
export function userOrIpKey(prefix: string) {
  return (req: FastifyRequest): string => {
    const userId = req.user?.id;
    return bound(userId ? `${prefix}:user:${userId}` : `${prefix}:ip:${normalizeIp(req.ip)}`);
  };
}

/** Key strictly by client IP — for routes with no authenticated user yet. */
export function ipKey(prefix: string) {
  return (req: FastifyRequest): string => bound(`${prefix}:ip:${normalizeIp(req.ip)}`);
}
