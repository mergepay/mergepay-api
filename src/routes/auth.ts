import { FastifyInstance } from "fastify";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { Errors } from "../errors";
import { buildChallenge, verifyChallenge } from "../services/sep10";
import { signToken, requireUser } from "../plugins/auth";
import { serializeUser } from "../serializers";
import { audit } from "../services/audit";
import {
  RefreshTokenError,
  issueRefreshToken,
  revokeAllForUser,
  rotateRefreshToken,
  unauthorizedForRefresh,
} from "../services/refresh-token";
import { rateLimited } from "../lib/rate-limit";

function shortName(pk: string): string {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export default async function authRoutes(app: FastifyInstance) {
  // Requesting a challenge is cheap and legitimately retried (e.g. a wallet
  // extension polling while the user approves), so it gets a more generous
  // limit than completing the actual login. Verifying is the actual
  // authentication step and is kept tighter to slow down brute-force attempts.
  // Both buckets are keyed strictly by client IP — there is no authenticated
  // user yet, and the wallet's public key must never become a bucket key,
  // because differing 429 behaviour would then reveal whether an account is
  // known to the API.
  const challengeLimit = rateLimited("authChallenge");
  const verifyLimit = rateLimited("authVerify");

  app.post(
    "/auth/challenge",
    challengeLimit,
    async (req) => {
      const body = z.object({ account: z.string() }).parse(req.body);
      if (!StrKey.isValidEd25519PublicKey(body.account)) {
        throw Errors.badRequest("invalid_account", "Not a valid Stellar public key");
      }
      return buildChallenge(body.account);
    }
  );

  app.post(
    "/auth/verify",
    verifyLimit,
    async (req) => {
      const body = z.object({ transaction: z.string() }).parse(req.body);
      const publicKey = await verifyChallenge(body.transaction);

      const user = await prisma.user.upsert({
        where: { stellarPublicKey: publicKey },
        update: {},
        create: {
          stellarPublicKey: publicKey,
          displayName: shortName(publicKey),
        },
      });

      // The claims contract is unchanged by SEP-10 hardening: verification
      // still yields a public key, and the session is still minted here.
      const token = signToken({ id: user.id, stellarPublicKey: publicKey });
      // A fresh family per login, so revoking one compromised session does
      // not sign the user out of their other devices.
      const refresh = await issueRefreshToken(user.id);
      await audit({
        userId: user.id,
        action: "auth.verify",
        entityType: "user",
        entityId: user.id,
        outcome: "success",
      });
      return {
        token,
        // `token` is retained under its original name so existing clients keep
        // working; the refresh pair is additive.
        refreshToken: refresh.token,
        refreshTokenExpiresAt: refresh.expiresAt.toISOString(),
        user: serializeUser(user),
      };
    }
  );

  /**
   * Exchange a refresh token for a new access token and a new refresh token.
   *
   * Rate-limited like verification: this mints a session, so it deserves the
   * same brute-force budget as the endpoint it stands in for. Every rejection
   * — malformed, unknown, expired, revoked, or reused — returns the same 401,
   * because distinguishing them would let a caller probe the token store.
   */
  app.post("/auth/refresh", verifyLimit, async (req) => {
    const body = z
      .object({ refreshToken: z.string().min(1).max(512) })
      .parse(req.body);

    let rotated;
    try {
      rotated = await rotateRefreshToken(body.refreshToken);
    } catch (err) {
      if (err instanceof RefreshTokenError) {
        // Reuse is the one case worth recording: it means a token was held by
        // two parties, and the whole family has just been revoked.
        if (err.reason === "reused") {
          await audit({
            action: "auth.refresh.reuse_detected",
            entityType: "refresh_token",
            entityId: "redacted",
            outcome: "failure",
          });
        }
        throw unauthorizedForRefresh();
      }
      throw err;
    }

    const user = await prisma.user.findUnique({ where: { id: rotated.userId } });
    if (!user) throw unauthorizedForRefresh();

    const token = signToken({
      id: user.id,
      stellarPublicKey: user.stellarPublicKey,
    });

    await audit({
      userId: user.id,
      action: "auth.refresh",
      entityType: "user",
      entityId: user.id,
      outcome: "success",
    });

    return {
      token,
      refreshToken: rotated.refresh.token,
      refreshTokenExpiresAt: rotated.refresh.expiresAt.toISOString(),
      user: serializeUser(user),
    };
  });

  /**
   * Log out.
   *
   * Access tokens are stateless and simply expire, but the refresh tokens
   * behind them must be revoked or a logged-out session could be revived.
   * Unauthenticated callers still get `ok` — logout is not an oracle for
   * whether a token was valid.
   */
  app.post("/auth/logout", async (req) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return { ok: true };

    try {
      await app.authenticate(req, null as never);
      const auth = requireUser(req);
      await revokeAllForUser(auth.id);
      await audit({
        userId: auth.id,
        action: "auth.logout",
        entityType: "user",
        entityId: auth.id,
        outcome: "success",
      });
    } catch {
      // An invalid or expired token has nothing to revoke.
    }

    return { ok: true };
  });

  app.get(
    "/me",
    { preHandler: [app.authenticate] },
    async (req) => {
      const auth = requireUser(req);
      const user = await prisma.user.findUnique({ where: { id: auth.id } });
      if (!user) throw Errors.notFound("User not found");
      return { user: serializeUser(user) };
    }
  );

  app.patch(
    "/me",
    { preHandler: [app.authenticate] },
    async (req) => {
      const auth = requireUser(req);
      const body = z
        .object({
          displayName: z.string().min(1).max(40).optional(),
          avatarUrl: z.string().url().nullable().optional(),
        })
        .parse(req.body);
      const user = await prisma.user.update({
        where: { id: auth.id },
        data: {
          ...(body.displayName !== undefined && { displayName: body.displayName }),
          ...(body.avatarUrl !== undefined && { avatarUrl: body.avatarUrl }),
        },
      });
      return { user: serializeUser(user) };
    }
  );
}
