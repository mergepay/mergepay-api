import { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db";
import { requireUser } from "../plugins/auth";

export default async function accountRoutes(app: FastifyInstance) {
  app.addHook("preHandler", app.authenticate);

  // GET /accounts/:id/balances - Get cached balances for an account
  app.get("/accounts/:id/balances", async (req) => {
    const auth = requireUser(req);
    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);

    // First, try to find a group by ID
    const group = await prisma.group.findFirst({
      where: {
        id,
        members: { some: { userId: auth.id } },
      },
      select: {
        id: true,
        treasuryAccountPublicKey: true,
      },
    });

    let accountId: string | null = null;

    if (group && group.treasuryAccountPublicKey) {
      accountId = group.treasuryAccountPublicKey;
    } else {
      // Check if the ID is a stellar public key directly
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { id },
            { stellarPublicKey: id },
          ],
        },
        select: {
          stellarPublicKey: true,
        },
      });

      if (user?.stellarPublicKey) {
        accountId = user.stellarPublicKey;
      }
    }

    if (!accountId) {
      return { balances: [] };
    }

    const balances = await prisma.accountBalance.findMany({
      where: { accountId },
      orderBy: { assetCode: "asc" },
    });

    return {
      balances: balances.map((b) => ({
        assetCode: b.assetCode,
        balance: b.balance.toString(),
        updatedAt: b.updatedAt.toISOString(),
      })),
    };
  });
}
