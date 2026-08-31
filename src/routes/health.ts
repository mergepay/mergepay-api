import { FastifyInstance } from "fastify";
import { getReadiness } from "../services/health";

export default async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async (_request, reply) => {
    const readiness = await getReadiness();
    const statusCode = readiness.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(readiness);
  });
}
