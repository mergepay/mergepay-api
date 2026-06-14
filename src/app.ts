import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { ZodError } from "zod";
import { config } from "./config";
import { AppError } from "./errors";
import authPlugin from "./plugins/auth";
import authRoutes from "./routes/auth";
import groupRoutes from "./routes/groups";
import expenseRoutes from "./routes/expenses";
import settlementRoutes from "./routes/settlements";
import treasuryRoutes from "./routes/treasury";
import anchorRoutes from "./routes/anchors";
import historyRoutes from "./routes/history";
import uploadRoutes from "./routes/uploads";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.isTest
      ? false
      : {
          level: process.env.LOG_LEVEL ?? "info",
          transport:
            config.NODE_ENV === "development"
              ? { target: "pino-pretty", options: { colorize: true } }
              : undefined,
        },
    bodyLimit: 6 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  const corsOrigin =
    config.WEB_URL === "*"
      ? true
      : config.WEB_URL.split(",").map((o) => o.trim());
  await app.register(cors, {
    origin: corsOrigin,
    credentials: false,
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
    allowList: config.isTest ? () => true : undefined,
  });
  await app.register(multipart, {
    limits: { fileSize: 6 * 1024 * 1024, files: 1 },
  });

  // Serve uploaded receipts.
  await app.register(fastifyStatic, {
    root: path.resolve(config.UPLOADS_DIR),
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(authPlugin);

  // Centralised error handling -> { error: { code, message } }.
  // Set on the root BEFORE registering routes so encapsulated route plugins
  // inherit it.
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      const first = err.errors[0];
      const field = first?.path.join(".");
      return reply.code(400).send({
        error: {
          code: "validation_error",
          message: field ? `${field}: ${first.message}` : first.message,
        },
      });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({
        error: { code: err.code, message: err.message },
      });
    }
    if ((err as any).statusCode === 429) {
      return reply.code(429).send({
        error: { code: "rate_limited", message: "Too many requests, slow down." },
      });
    }
    // Multipart / fastify validation errors.
    if ((err as any).statusCode && (err as any).statusCode < 500) {
      return reply.code((err as any).statusCode).send({
        error: { code: "bad_request", message: err.message },
      });
    }
    app.log.error(err);
    return reply.code(500).send({
      error: { code: "internal_error", message: "Something went wrong." },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({
      error: { code: "not_found", message: "Route not found" },
    });
  });

  // Health check.
  app.get("/health", async () => ({
    status: "ok",
    network: config.STELLAR_NETWORK,
    time: new Date().toISOString(),
  }));

  // Routes.
  await app.register(authRoutes);
  await app.register(groupRoutes);
  await app.register(expenseRoutes);
  await app.register(settlementRoutes);
  await app.register(treasuryRoutes);
  await app.register(anchorRoutes);
  await app.register(historyRoutes);
  await app.register(uploadRoutes);

  return app;
}
