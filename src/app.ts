import fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config";
import { prisma } from "./db";
import { AppError } from "./lib/errors";
import authPlugin from "./plugins/auth";
import anchorRoutes from "./routes/anchors";
import authRoutes from "./routes/auth";
import expenseRoutes from "./routes/expenses";
import groupRoutes from "./routes/groups";
import historyRoutes from "./routes/history";
import settlementRoutes from "./routes/settlements";
import treasuryRoutes from "./routes/treasury";
import uploadRoutes from "./routes/uploads";

export async function buildApp() {
  const app = fastify({
    logger: true,
    requestIdHeader: "x-request-id",
    genReqId: () => `req-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(helmet);
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  await app.register(authPlugin);

  // Health check
  app.get("/health", async () => ({ status: "ok" }));

  // Register routes
  await app.register(authRoutes, { prefix: "" });
  await app.register(anchorRoutes, { prefix: "" });
  await app.register(expenseRoutes, { prefix: "" });
  await app.register(groupRoutes, { prefix: "" });
  await app.register(historyRoutes, { prefix: "" });
  await app.register(settlementRoutes, { prefix: "" });
  await app.register(treasuryRoutes, { prefix: "" });
  await app.register(uploadRoutes, { prefix: "" });

  return app;
}
