import { FastifyInstance } from "fastify";
import { getReadiness } from "../services/health";

let lastLoggedDegradedReadiness: string | null = null;

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (request, reply) => {
    const readiness = await getReadiness();
    const statusCode = readiness.status === "ok" ? 200 : 503;

    if (
      statusCode === 503 &&
      lastLoggedDegradedReadiness !== readiness.timestamp
    ) {
      request.log.warn(
        {
          databaseConnected: readiness.database.connected,
          stellarReachable: readiness.stellar.reachable,
          network: readiness.stellar.network,
        },
        "Health readiness check is degraded"
      );
      lastLoggedDegradedReadiness = readiness.timestamp;
    }

    return reply.code(statusCode).send(readiness);
  });
}
