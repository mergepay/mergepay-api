import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import jwt, { JwtPayload, TokenExpiredError } from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config";
import { Errors } from "../errors";

/**
 * Minimum remaining lifetime (seconds) a JWT must have when presented.
 * Tokens whose `exp` claim is closer than this margin to the current clock
 * are rejected as near-expired.
 */
const TOKEN_EXPIRY_MARGIN_SECONDS = config.TOKEN_EXPIRY_MARGIN_SECONDS ?? 30;

/** Client-facing hint for recovering an expired session. */
const REAUTH_HINT = {
  code: "REAUTHENTICATE",
  message:
    "Your session has expired. Re-authenticate via SEP-10 to continue, or refresh your session if you hold a valid refresh token.",
  endpoints: {
    sep10Challenge: "/auth/challenge",
    sep10Verify: "/auth/verify",
    refresh: "/auth/refresh",
  },
} as const;

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
 *
 * Failures are reported distinctly so a client can tell a recoverable
 * expiry (TOKEN_EXPIRED — re-authenticate or refresh) from a token that can
 * never be redeemed (INVALID_TOKEN — re-authenticate only):
 *
 *  - `TokenExpiredError` → TOKEN_EXPIRED. The SDK raises this before
 *    anything else can be concluded, so the `exp` check below is the
 *    defence-in-depth path for the configured near-expiry margin.
 *  - every other jsonwebtoken failure (`JsonWebTokenError`,
 *    `NotBeforeError`, …) → INVALID_TOKEN.
 *  - a structurally impossible payload → INVALID_TOKEN.
 */
export function verifyToken(token: string): AuthUser {
  let decoded: JwtPayload;
  try {
    decoded = jwt.verify(token, config.JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    }) as JwtPayload;
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      throw Errors.tokenExpired(undefined, REAUTH_HINT);
    }
    // Malformed JWT, wrong signature, disallowed algorithm, wrong
    // issuer/audience, token not yet valid — none of these can be redeemed
    // by refreshing, so they share one code and one message.
    throw Errors.invalidToken(undefined, REAUTH_HINT);
  }

  // Tokens this server mints always carry an expiry, so a well-signed
  // payload without `exp` is not a session we issued. Requiring the claim
  // also makes the margin check below unconditional.
  if (typeof decoded.exp !== "number") {
    throw Errors.invalidToken();
  }

  // Reject tokens that are too close to expiry: even though the SDK's own
  // check would still accept them within this margin, a token forged or
  // replayed moments before expiry should never grant a session. Reported
  // as TOKEN_EXPIRED because the client remedy is the same: get a new one.
  const remainingSeconds = decoded.exp - Math.floor(Date.now() / 1000);
  if (remainingSeconds < TOKEN_EXPIRY_MARGIN_SECONDS) {
    throw Errors.tokenExpired(undefined, REAUTH_HINT);
  }

  const { sub, pk } = decoded;
  if (typeof sub !== "string" || !sub || typeof pk !== "string" || !pk) {
    throw Errors.invalidToken();
  }

  return { id: sub, stellarPublicKey: pk };
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

  const token = parsedHeader.data.slice("Bearer ".length).trim();
  // verifyToken already throws the precise AppError; do not re-wrap it —
  // wrapping is what used to flatten TOKEN_EXPIRED into a generic 401.
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
