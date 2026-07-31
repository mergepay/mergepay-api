import { FastifyInstance } from "fastify";
import { Horizon } from "@stellar/stellar-sdk";
import { prisma } from "../db";
import { config } from "../config";

export default async function healthRoutes(app: FastifyInstance) {
  const healthLimit = {
    config: { rateLimit: { max: config.RATE_LIMIT_HEALTH, timeWindow: "1 minute" } },
  };

  app.get(
    "/health",
    healthLimit,
    async (_req, reply) => {
      let dbStatus = "connected";
      let stellarStatus = "reachable";

      try {
        await prisma.$queryRaw`SELECT 1`;
      } catch {
        dbStatus = "unreachable";
      }

      try {
        const horizon = new Horizon.Server(config.HORIZON_URL);
        await Promise.race([
          horizon.fetchBaseFee(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("timeout")), 5000)
          ),
        ]);
      } catch {
        stellarStatus = "unreachable";
      }

      const allUp = dbStatus === "connected" && stellarStatus === "reachable";
      const components: Record<string, string> = { database: dbStatus, stellar: stellarStatus };
      const status = allUp ? "ok" : "degraded";

      const body = { status, components };

      if (!allUp) {
        return reply.code(503).send(body);
      }

      return reply.send(body);
    }
  );
}
