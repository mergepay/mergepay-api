import { FastifyInstance } from "fastify";
import { checkDatabase } from "../services/health";
import { config } from "../config";
import { version } from "../../package.json";

export default async function healthRoutes(app: FastifyInstance) {
  // Lightweight liveness probe — no dependency checks.
  app.get("/health", async (_request, reply) => {
    return reply.code(200).send({
      status: "ok",
      uptime: process.uptime(),
      version,
    });
  });

  // Readiness probe — checks database and Stellar Horizon.
  app.get("/health/ready", async (_request, reply) => {
    const [dbUp, stellarUp] = await Promise.all([
      checkDatabase(),
      (async () => {
        try {
          const res = await fetch(`${config.HORIZON_URL}`);
          return res.ok;
        } catch {
          return false;
        }
      })(),
    ]);

    const status = dbUp && stellarUp ? "ok" : "degraded";
    const statusCode = status === "ok" ? 200 : 503;

    return reply.code(statusCode).send({
      status,
      uptime: process.uptime(),
      version,
      database: { status: dbUp ? "up" : "down", latencyMs: 0 },
      stellar: { status: stellarUp ? "up" : "down", latencyMs: 0 },
    });
  });
}
