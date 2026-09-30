/**
 * Typed JWT utility wrapper — issue #421.
 *
 * Every protected route in the API authenticates with a JSON Web Token, so the
 * pair that mints and verifies those tokens is the single most security-
 * sensitive piece of code in the service layer. This module is the one place
 * that logic lives: a strongly-typed `signToken` / `verifyToken` pair plus the
 * `jwtClaimsSchema` that describes the payload shape this server issues.
 *
 * The claims contract is deliberately explicit and small:
 *
 *  - `sub` — the local user id the session belongs to.
 *  - `pk`  — that user's Stellar public key, so a route can authorize without
 *            a database round-trip on the hot path.
 *
 * `signToken` sets the algorithm, issuer, audience, and expiry from validated
 * configuration (`src/config.ts` reads `JWT_SECRET` and friends from the
 * environment through Zod, and refuses to boot without them), so no caller can
 * accidentally mint a token with a weaker algorithm or an unbounded lifetime.
 * `verifyToken` re-checks all of those plus the signature, and rejects a
 * payload that does not satisfy `jwtClaimsSchema` — a tampered or foreign
 * token can never be coerced into authenticating as an arbitrary account.
 *
 * The Fastify plugin in `src/plugins/auth.ts` is a thin consumer of this
 * module (it wires `authenticate`/`requireUser` onto the request), and the many
 * existing imports of `signToken`/`verifyToken` from that plugin are kept
 * working by re-export. Keeping the crypto in a plain service — rather than in
 * the plugin — means it can be unit-tested without building a Fastify instance.
 */
import jwt, { JwtPayload, TokenExpiredError } from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config";
import { Errors } from "../errors";

/** The identity a verified session resolves to. */
export interface AuthUser {
  id: string;
  stellarPublicKey: string;
}

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

const JWT_ALGORITHM = "HS256" as const;

/**
 * The payload shape this server expects to find in a session token.
 *
 * Only `sub` and `pk` are Mergepay's own claims and the only ones a session
 * meaningfully needs; the registered claims below are optional because
 * `jsonwebtoken` — not the payload object — populates them (`exp`, `iat`,
 * `jti`), and `iss`/`aud` are re-validated against configuration by the SDK
 * before this schema is ever consulted. Unknown keys are ignored rather than
 * rejected: the signature already guarantees the token was minted here, so a
 * future claim must not make old verifiers reject valid sessions.
 */
export const jwtClaimsSchema = z.object({
  sub: z.string().min(1),
  pk: z.string().min(1),
  iss: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iat: z.number().optional(),
  exp: z.number().optional(),
  nbf: z.number().optional(),
  jti: z.string().optional(),
});

/** The validated session payload. */
export type JwtClaims = z.infer<typeof jwtClaimsSchema>;

/**
 * Mint a session token. `jwtid` is set for SEP-10 logins to the challenge
 * transaction hash, which SEP-10 names as the token's `jti`.
 */
export function signToken(user: AuthUser, opts: { jwtid?: string } = {}): string {
  return jwt.sign(
    { sub: user.id, pk: user.stellarPublicKey },
    config.JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      expiresIn: config.jwtExpiresIn,
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
      ...(opts.jwtid ? { jwtid: opts.jwtid } : {}),
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
 * Rejections are classified so the client can pick the right remedy: an
 * expired token is `TOKEN_EXPIRED` — the credential was once good and the
 * session can be refreshed or re-established via SEP-10 — while anything
 * unverifiable (malformed JWT, wrong signature, wrong issuer or audience,
 * not-yet-valid, missing claims) is `INVALID_TOKEN`. Only the coarse code is
 * returned; the underlying jsonwebtoken error text is never echoed, because
 * it can leak which claim mismatched.
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

  // The claim shape is the Zod contract, so the expected payload and the
  // enforced payload are one definition that cannot drift.
  const claims = jwtClaimsSchema.safeParse(decoded);
  if (!claims.success) {
    throw Errors.invalidToken();
  }

  return { id: claims.data.sub, stellarPublicKey: claims.data.pk };
}
