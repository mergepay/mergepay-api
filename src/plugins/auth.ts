import { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { z } from "zod";
import { AppError, Errors } from "../errors";
import { verifyToken } from "../services/jwt";
import type { AuthUser } from "../services/jwt";
import { authenticateChallenge, classifySep10Error, type VerifiedChallenge } from "../services/auth";
import { assertSep10TransactionEnvelope } from "../validations/sep10";

/*
 * The JWT utilities live in src/services/jwt.ts (issue #421) and the unified auth
 * service in src/services/auth.ts (issue #885). They are re-exported here so this
 * plugin stays the single import point the routes and tests have always used, while
 * the crypto itself remains unit-testable without building a Fastify instance.
 */
export { signToken, verifyToken } from "../services/jwt";
export { authenticateChallenge, buildChallenge, verifyChallenge, classifySep10Error } from "../services/auth";
export type { AuthUser } from "../services/jwt";
export type { VerifiedChallenge } from "../services/auth";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
    sep10Account?: string;
    sep10Challenge?: VerifiedChallenge;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateSep10: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/**
 * `Bearer <token68>` (RFC 6750 §2.1): the scheme, exactly one space, and one
 * token with no further parts. The scheme is matched case-sensitively, as the
 * rate limiter's identity key (src/plugins/rate-limit.ts) is — a spelling one
 * accepted and the other did not would move an authenticated caller out of its
 * per-user bucket.
 */
const authorizationHeaderSchema = z
  .string()
  .regex(/^Bearer [A-Za-z0-9\-._~+/]+=*$/, "Authorization must be 'Bearer <token>'");

/**
 * Authenticate a request from its `Authorization` header.
 *
 * Each failure has its own stable code so clients can branch without parsing
 * messages: MISSING_TOKEN (no header), MALFORMED_TOKEN (not `Bearer <token>`,
 * or not a JWT), and from `verifyToken` TOKEN_EXPIRED / INVALID_TOKEN. All are
 * 401s carrying an RFC 6750 `WWW-Authenticate` challenge (set by the error
 * handler). The JWT library's own error text is never echoed back.
 *
 * Emits structured warning logs via pino without leaking sensitive tokens or keys (#802).
 */
async function authenticate(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  if (header === undefined || header.trim() === "") {
    req.log.warn(
      { authFailure: "missing_token", ip: req.ip, path: req.url, method: req.method },
      "Authentication failed: missing authorization header"
    );
    throw Errors.missingToken();
  }

  // Handle SEP10 challenge scheme if presented in Authorization header
  if (header.startsWith("SEP10 ") || header.startsWith("sep10 ")) {
    const xdr = header.slice(6).trim();
    if (!xdr) {
      req.log.warn(
        { authFailure: "malformed_sep10_header", ip: req.ip, path: req.url, method: req.method },
        "Authentication failed: empty SEP-10 transaction XDR in header"
      );
      throw Errors.malformedToken("Authorization header must contain valid SEP-10 transaction XDR");
    }
    try {
      assertSep10TransactionEnvelope(xdr);
      const verified = await authenticateChallenge(xdr);
      req.sep10Account = verified.account;
      req.sep10Challenge = verified;
      req.user = { id: verified.account, stellarPublicKey: verified.account };
      return;
    } catch (err) {
      const classified = classifySep10Error(err);
      req.log.warn(
        {
          authFailure: "sep10_challenge_invalid",
          errorCode: classified.code,
          errorMessage: classified.message,
          ip: req.ip,
          path: req.url,
          method: req.method,
        },
        "Authentication failed: invalid SEP-10 challenge"
      );
      throw classified;
    }
  }

  const parsedHeader = authorizationHeaderSchema.safeParse(header);
  if (!parsedHeader.success) {
    req.log.warn(
      { authFailure: "malformed_token", ip: req.ip, path: req.url, method: req.method },
      "Authentication failed: malformed Bearer authorization header"
    );
    throw Errors.malformedToken("Authorization header must be of the form 'Bearer <token>'");
  }

  try {
    req.user = verifyToken(parsedHeader.data.slice("Bearer ".length));
  } catch (err) {
    const classified = err instanceof AppError ? err : Errors.invalidToken();
    req.log.warn(
      {
        authFailure: classified.code.toLowerCase(),
        errorCode: classified.code,
        errorMessage: classified.message,
        ip: req.ip,
        path: req.url,
        method: req.method,
      },
      `Authentication failed: ${classified.code === "TOKEN_EXPIRED" ? "session token expired" : "invalid token"}`
    );
    throw classified;
  }
}

/**
 * Dedicated Fastify hook for verifying SEP-10 challenge transactions directly.
 * Accepts challenge XDR via X-SEP10-Challenge header, Authorization: SEP10 <xdr>,
 * or request body transaction field.
 */
async function authenticateSep10(req: FastifyRequest, _reply: FastifyReply) {
  const header = req.headers.authorization;
  const challengeHeader = req.headers["x-sep10-challenge"] as string | undefined;

  let xdr = challengeHeader;
  if (!xdr && header && (header.startsWith("SEP10 ") || header.startsWith("sep10 "))) {
    xdr = header.slice(6).trim();
  }
  if (!xdr && req.body && typeof req.body === "object" && "transaction" in req.body) {
    xdr = (req.body as { transaction: string }).transaction;
  }

  if (!xdr || typeof xdr !== "string" || xdr.trim() === "") {
    req.log.warn(
      { authFailure: "missing_challenge", ip: req.ip, path: req.url, method: req.method },
      "SEP-10 authentication failed: missing challenge transaction"
    );
    throw Errors.badRequest("missing_challenge", "SEP-10 challenge transaction is required");
  }

  try {
    assertSep10TransactionEnvelope(xdr.trim());
    const verified = await authenticateChallenge(xdr.trim());
    req.sep10Account = verified.account;
    req.sep10Challenge = verified;
    req.user = { id: verified.account, stellarPublicKey: verified.account };
  } catch (err) {
    const classified = classifySep10Error(err);
    req.log.warn(
      {
        authFailure: "sep10_challenge_invalid",
        errorCode: classified.code,
        errorMessage: classified.message,
        ip: req.ip,
        path: req.url,
        method: req.method,
      },
      "SEP-10 authentication failed: invalid challenge transaction"
    );
    throw classified;
  }
}

export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate("authenticate", authenticate);
  app.decorate("authenticateSep10", authenticateSep10);
});

/** Read the authenticated user or throw 401. */
export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}
