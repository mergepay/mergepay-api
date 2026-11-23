/**
 * Unified Authentication Service — Issue #885.
 *
 * Coordinates SEP-10 Stellar Web Authentication challenge lifecycle and JWT session
 * token verification. Distinguishes granular failure modes (expired challenges,
 * invalid signatures, domain mismatches, network mismatches) while preventing
 * sensitive key material or internal stack traces from leaking to clients.
 */

import { AppError, ErrorCode, Errors } from "../errors";
import {
  authenticateChallenge as sep10Authenticate,
  buildChallenge as sep10Build,
  verifyChallenge as sep10Verify,
  validateChallengeTimeBounds,
  cleanupExpiredChallenges,
  serverKeypair,
  CHALLENGE_VALIDITY_SECONDS,
  type VerifiedChallenge,
} from "./sep10";
import { signToken as jwtSign, verifyToken as jwtVerify, type AuthUser, type JwtClaims, jwtClaimsSchema } from "./jwt";

export {
  serverKeypair,
  CHALLENGE_VALIDITY_SECONDS,
  cleanupExpiredChallenges,
  validateChallengeTimeBounds,
  jwtClaimsSchema,
};
export {
  assertSep10TransactionEnvelope,
  validateSep10DomainClaims,
} from "../validations/sep10";
export type { VerifiedChallenge, AuthUser, JwtClaims };

type Sep10FailureCode =
  | typeof ErrorCode.CHALLENGE_EXPIRED
  | typeof ErrorCode.CHALLENGE_NOT_YET_VALID
  | typeof ErrorCode.CHALLENGE_WINDOW_TOO_LONG
  | typeof ErrorCode.HOME_DOMAIN_MISMATCH
  | typeof ErrorCode.NETWORK_MISMATCH
  | typeof ErrorCode.INVALID_SIGNATURE
  | typeof ErrorCode.INVALID_CHALLENGE;

interface Sep10FailureRule {
  code: Sep10FailureCode;
  pattern: RegExp;
  build: () => AppError;
}

const SEP10_FAILURE_RULES: readonly Sep10FailureRule[] = [
  {
    code: ErrorCode.CHALLENGE_EXPIRED,
    pattern: /\b(expired past|has expired|transaction expired|timebound.*expired)\b/i,
    build: () =>
      Errors.challengeExpired(
        "Authentication challenge has expired. Request a new challenge and sign it promptly.",
        { challengeValiditySeconds: CHALLENGE_VALIDITY_SECONDS }
      ),
  },
  {
    code: ErrorCode.CHALLENGE_NOT_YET_VALID,
    pattern: /\b(not yet valid|min_time|not_yet_valid)\b/i,
    build: () =>
      Errors.challengeNotYetValid(
        "Authentication challenge is not valid yet. Request a new challenge and sign it promptly."
      ),
  },
  {
    code: ErrorCode.CHALLENGE_WINDOW_TOO_LONG,
    pattern: /\b(window|timebounds?)\b.*\b(too long|exceeds|longer than)\b/i,
    build: () =>
      Errors.challengeWindowTooLong(
        "Authentication challenge window is longer than this server issues. Request a new challenge."
      ),
  },
  {
    code: ErrorCode.HOME_DOMAIN_MISMATCH,
    pattern: /\b(home\s*domain|homedomain|domain mismatch)\b/i,
    build: () =>
      Errors.challengeHomeDomainMismatch(
        "Authentication challenge was issued for a different home domain. Request a new challenge from this server."
      ),
  },
  {
    code: ErrorCode.NETWORK_MISMATCH,
    pattern: /\bnetwork\b.*\b(mismatch|passphrase)\b|\bpassphrase\b.*\b(mismatch|network)\b/i,
    build: () =>
      Errors.challengeNetworkMismatch(
        "Authentication challenge was issued for a different Stellar network. Request a new challenge from this server and sign it for its network."
      ),
  },
  {
    code: ErrorCode.INVALID_SIGNATURE,
    pattern: /\b(signatures?|signers?|thresholds?)\b/i,
    build: () =>
      Errors.challengeSignatureInvalid(
        "Challenge signature verification failed. Ensure the challenge is signed by the account's signing key(s) before submitting."
      ),
  },
];

export function classifySep10Error(error: unknown, account?: string): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error ?? "");
  for (const rule of SEP10_FAILURE_RULES) {
    if (rule.pattern.test(message)) return rule.build();
  }

  return Errors.invalidChallenge();
}

/**
 * Builds an unsigned SEP-10 challenge transaction for the specified account.
 */
export function buildChallenge(account: string): {
  transaction: string;
  networkPassphrase: string;
} {
  return sep10Build(account);
}

/**
 * Verifies a signed SEP-10 challenge transaction, catching and classifying
 * failures into explicit, client-safe AppErrors.
 */
export async function verifyChallenge(signedXdr: string): Promise<string> {
  try {
    return await sep10Verify(signedXdr);
  } catch (error) {
    throw classifySep10Error(error);
  }
}

/**
 * Authenticates a signed SEP-10 challenge transaction, returning the verified
 * account and the challenge hash identifier.
 */
export async function authenticateChallenge(signedXdr: string): Promise<VerifiedChallenge> {
  try {
    return await sep10Authenticate(signedXdr);
  } catch (error) {
    throw classifySep10Error(error);
  }
}

/**
 * Mint a session token for an authenticated user.
 */
export function signToken(user: AuthUser, opts?: { jwtid?: string }): string {
  return jwtSign(user, opts);
}

/**
 * Verify an access token and return the authenticated user identity.
 */
export function verifyToken(token: string): AuthUser {
  return jwtVerify(token);
}
