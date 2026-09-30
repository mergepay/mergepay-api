import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { Errors } from "../errors";
import { verifyToken } from "../services/jwt";
import type { AuthUser } from "../services/jwt";

/*
 * The JWT utilities live in src/services/jwt.ts (issue #421). They are
 * re-exported here so this plugin stays the single import point the routes
 * and tests have always used, while the crypto itself remains unit-testable
 * without building a Fastify instance.
 */
export { signToken, verifyToken } from "../services/jwt";
export type { AuthUser } from "../services/jwt";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const authorizationHeaderSchema = z
  .string()
  .regex(/^Bearer\s+\S+$/, "Authorization must use the Bearer scheme");

/**
 * Authenticate a request from its `Authorization` header.
 *
 * Missing/undecodable credentials and a rejected token are reported with
 * different codes (UNAUTHORIZED vs TOKEN_EXPIRED/INVALID_TOKEN) so clients
 * can branch on the failure without parsing messages. The SDK's own error
 * text is never echoed back — only the stable codes and the re-auth hint.
 */
async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const parsedHeader = authorizationHeaderSchema.safeParse(req.headers.authorization);
  if (!parsedHeader.success) {
    // No usable Authorization header at all: not a token verdict, so this
    // keeps the original generic code rather than INVALID_TOKEN.
    throw Errors.unauthorized();
  }

  // verifyToken raises the specific 401 the caller should act on —
  // TOKEN_EXPIRED with a re-authentication hint, INVALID_TOKEN for anything
  // unverifiable — so those AppErrors must reach the error handler unmodified.
  const token = parsedHeader.data.slice("Bearer ".length).trim();
  req.user = verifyToken(token);
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate("authenticate", authenticate);
});

/** Read the authenticated user or throw 401. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}
