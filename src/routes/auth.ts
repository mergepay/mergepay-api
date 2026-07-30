import { FastifyInstance } from "fastify";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { Errors } from "../errors";
import { buildChallenge, verifyChallenge } from "../services/sep10";
import { signToken, requireUser } from "../plugins/auth";
import { serializeUser } from "../serializers";
import { audit } from "../services/audit";
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

      const token = signToken({ id: user.id, stellarPublicKey: publicKey });
      await audit({
        userId: user.id,
        action: "auth.verify",
        entityType: "user",
        entityId: user.id,
      });
      return { token, user: serializeUser(user) };
    }
  );

  app.post("/auth/logout", async () => ({ ok: true }));

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
