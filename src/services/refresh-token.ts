/**
 * Rotating refresh tokens for SEP-10 sessions.
 *
 * SEP-10 authenticates by having the user's wallet sign a challenge. That is a
 * good way to prove key ownership and a poor thing to repeat: every expiry
 * prompts the wallet — often a hardware device — to sign again. Short-lived
 * access tokens paired with a refresh token move that cost off the critical
 * path without lengthening the window a stolen access token is useful for.
 *
 * The security properties this module is responsible for:
 *
 *  - **Only hashes are stored.** A refresh token is a random 256-bit secret;
 *    the database holds its SHA-256. A dumped table yields no usable
 *    credential. Lookup is by hash, so this costs nothing.
 *  - **Single use.** Redeeming a token marks it rotated and issues a
 *    successor. The unique index on the hash makes that atomic: two requests
 *    racing on one token cannot both win.
 *  - **Reuse revokes the family.** Every token descended from one login shares
 *    a `familyId`. Presenting an already-rotated token means two parties hold
 *    it — the legitimate client and a thief — and nothing distinguishes them,
 *    so the entire family is revoked and both must re-authenticate. This is
 *    the standard detection for stolen refresh tokens: the theft is invisible
 *    until the copy is used, and then it is unmissable.
 *  - **Constant-time comparison is not needed on the token itself**, because
 *    lookup is by hash of the presented value rather than by comparing a
 *    stored secret. The hash is the index key; there is no secret-dependent
 *    branch to time.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Prisma, RefreshToken } from "@prisma/client";
import { prisma } from "../db";
import { config } from "../config";
import { Errors } from "../errors";

/** Bytes of entropy in a refresh token. */
const TOKEN_BYTES = 32;

/**
 * The wire format: base64url, no padding. Length is derived from the entropy
 * above rather than fixed, so changing one does not silently invalidate the
 * other.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,90}$/;

/** Zod-friendly shape check for an incoming token. */
export function isWellFormedToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

/** Hash a token for storage and lookup. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two hashes in constant time.
 *
 * Not used on the lookup path — that is an indexed equality on the hash — but
 * used where a caller-supplied value is checked against one already loaded,
 * so a comparison never leaks how many leading bytes matched.
 */
export function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Generate a fresh token and its stored hash. */
export function generateToken(): { token: string; tokenHash: string } {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

function expiryFromNow(now: Date): Date {
  return new Date(now.getTime() + config.REFRESH_TOKEN_TTL_MS);
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
  familyId: string;
}

/**
 * Issue the first refresh token of a new family, at SEP-10 login.
 *
 * A new family per login means revoking one compromised session does not log
 * the user out of their other devices.
 */
export async function issueRefreshToken(
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  now: Date = new Date()
): Promise<IssuedRefreshToken> {
  const { token, tokenHash } = generateToken();
  const expiresAt = expiryFromNow(now);
  const familyId = randomBytes(16).toString("hex");

  await db.refreshToken.create({
    data: { tokenHash, familyId, userId, expiresAt },
  });

  return { token, expiresAt, familyId };
}

/** Why a presented refresh token was refused. */
export type RefreshFailure = "malformed" | "unknown" | "expired" | "revoked" | "reused";

export class RefreshTokenError extends Error {
  readonly reason: RefreshFailure;

  constructor(reason: RefreshFailure) {
    super(`Refresh token rejected: ${reason}`);
    this.name = "RefreshTokenError";
    this.reason = reason;
  }
}

/**
 * Revoke every unrevoked token in a family.
 *
 * Called when reuse is detected. Already-rotated tokens are included: they
 * cannot be redeemed again anyway, but marking them revoked records that the
 * family was cut off rather than simply used up.
 */
export async function revokeFamily(
  familyId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  now: Date = new Date()
): Promise<number> {
  const { count } = await db.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now },
  });
  return count;
}

/** Revoke every live token for a user — logout across the session's devices. */
export async function revokeAllForUser(
  userId: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
  now: Date = new Date()
): Promise<number> {
  const { count } = await db.refreshToken.updateMany({
    where: { userId, revokedAt: null, rotatedAt: null },
    data: { revokedAt: now },
  });
  return count;
}

/**
 * Classify a stored token without mutating anything.
 *
 * Split out so the ordering of checks is visible and testable: reuse is
 * detected *before* expiry, because a replayed token that has since expired is
 * still evidence of theft and should still cut off the family.
 */
export function classifyStored(stored: RefreshToken | null, now: Date): RefreshFailure | null {
  if (!stored) return "unknown";
  if (stored.rotatedAt) return "reused";
  if (stored.revokedAt) return "revoked";
  if (stored.expiresAt.getTime() <= now.getTime()) return "expired";
  return null;
}

export interface RotationResult {
  userId: string;
  refresh: IssuedRefreshToken;
}

/**
 * Redeem a refresh token and issue its successor.
 *
 * Rotation runs in one transaction so the old token cannot be marked rotated
 * without its replacement existing, and the conditional update (`rotatedAt:
 * null` in the where clause) is what makes concurrent redemption safe: the
 * second request updates zero rows and is rejected as reuse.
 *
 * @throws RefreshTokenError for every rejection, so the route can map them to
 *   one 401 without leaking which case occurred.
 */
export async function rotateRefreshToken(
  presented: string,
  now: Date = new Date()
): Promise<RotationResult> {
  if (!isWellFormedToken(presented)) {
    throw new RefreshTokenError("malformed");
  }

  const tokenHash = hashToken(presented);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });

  const failure = classifyStored(stored, now);
  if (failure === "reused" && stored) {
    // The token was already exchanged, so two parties hold it. Nothing here
    // can tell which one is presenting it now, so the whole family goes.
    await revokeFamily(stored.familyId, prisma, now);
    throw new RefreshTokenError("reused");
  }
  if (failure || !stored) {
    throw new RefreshTokenError(failure ?? "unknown");
  }

  return prisma.$transaction(async (tx) => {
    // Conditional on still being unrotated: this is the atomic claim.
    const claimed = await tx.refreshToken.updateMany({
      where: { id: stored.id, rotatedAt: null, revokedAt: null },
      data: { rotatedAt: now },
    });
    if (claimed.count === 0) {
      // Lost the race against a concurrent redemption of the same token.
      throw new RefreshTokenError("reused");
    }

    const { token, tokenHash: nextHash } = generateToken();
    await tx.refreshToken.create({
      data: {
        tokenHash: nextHash,
        // The successor stays in the family, so a later reuse of any link in
        // the chain still revokes the whole session.
        familyId: stored.familyId,
        userId: stored.userId,
        expiresAt: expiryFromNow(now),
      },
    });

    return {
      userId: stored.userId,
      refresh: { token, expiresAt: expiryFromNow(now), familyId: stored.familyId },
    };
  });
}

/** Map any refresh failure onto one indistinguishable 401. */
export function unauthorizedForRefresh(): ReturnType<typeof Errors.unauthorized> {
  // Deliberately uniform: telling a caller whether a token was unknown,
  // expired, or revoked would let them probe the token store.
  return Errors.unauthorized("Invalid or expired refresh token");
}

/** Delete expired and long-revoked tokens. Intended for the cleanup worker. */
export async function cleanupExpiredRefreshTokens(now: Date = new Date()): Promise<number> {
  const { count } = await prisma.refreshToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return count;
}
