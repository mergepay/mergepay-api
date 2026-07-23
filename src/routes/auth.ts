import { FastifyInstance } from "fastify";
import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { Errors } from "../lib/errors";
import { buildChallenge, verifyChallenge } from "../services/sep10";
import { signToken, requireUser } from "../plugins/auth";
import { serializeUser } from "../serializers";
import { audit } from "../services/audit";

function shortName(pk: string): string {
  return `${pk.slice(0, 4)}…${pk.slice(-4)}`;
}

export default async function authRoutes(app: FastifyInstance) {
  // Tighter rate limit on auth endpoints.
  const authLimit = {
    config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
  };

  app.post("/auth/challenge", authLimit, async (req) => {
    const body = z.object({ account: z.string() }).parse(req.body);
    if (!StrKey.isValidEd25519PublicKey(body.account)) {
      throw Errors.badRequest("INVALID_ACCOUNT", "Not a valid Stellar public key");
    }
    return buildChallenge(body.account);
  });

  app.post("/auth/verify", authLimit, async (req) => {
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
  });

  app.post("/auth/logout", async () => ({ ok: true }));

  app.get("/me", { preHandler: [app.authenticate] }, async (req) => {
    const auth = requireUser(req);
    const user = await prisma.user.findUnique({ where: { id: auth.id } });
    if (!user) throw Errors.notFound("User not found");
    return { user: serializeUser(user) };
  });

  app.patch("/me", { preHandler: [app.authenticate] }, async (req) => {
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
  });
}
