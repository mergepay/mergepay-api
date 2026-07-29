import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { Errors } from "../errors";

export interface AuthUser {
  id: string;
  stellarPublicKey: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const JWT_ALGORITHM = "HS256" as const;

export function signToken(user: AuthUser): string {
  return jwt.sign(
    { sub: user.id, pk: user.stellarPublicKey },
    config.JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn: config.jwtExpiresIn,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }
  );
}

/**
 * Verify a bearer token and return the account it was issued for.
 *
 * Enforces algorithm, issuer, audience, and expiration in addition to the
 * signature so a token minted for a different environment/audience (or
 * signed with a different algorithm) is rejected outright, and validates the
 * claim shape so a malformed/tampered payload can't be coerced into
 * authenticating as an arbitrary account.
 */
export function verifyToken(token: string): AuthUser {
  let decoded: jwt.JwtPayload;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }) as jwt.JwtPayload;
  } catch {
    throw Errors.unauthorized();
  }

  const { sub, pk } = decoded;
  if (typeof sub !== "string" || !sub || typeof pk !== "string" || !pk) {
    throw Errors.unauthorized();
  }

  return { id: sub, stellarPublicKey: pk };
}

async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw Errors.unauthorized();
  }
  const token = header.slice("Bearer ".length).trim();
  try {
    req.user = verifyToken(token);
  } catch {
    throw Errors.unauthorized("Invalid or expired session");
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate("authenticate", authenticate);
});

/** Read the authenticated user or throw 401. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}
