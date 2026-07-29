import Fastify, { FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { config } from "./config";
import authPlugin from "./plugins/auth";
import errorHandlerPlugin from "./plugins/error-handler";
import authRoutes from "./routes/auth";
import groupRoutes from "./routes/groups";
import expenseRoutes from "./routes/expenses";
import settlementRoutes from "./routes/settlements";
import treasuryRoutes from "./routes/treasury";
import anchorRoutes from "./routes/anchors";
import historyRoutes from "./routes/history";
import uploadRoutes from "./routes/uploads";
import { getCorrelationId } from "./lib/correlation";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Disable Fastify's unvalidated request-id header handling. The incoming
    // values are validated by genReqId before becoming request.id.
    requestIdHeader: false,
    genReqId: (request) =>
      getCorrelationId(
        request.headers["x-correlation-id"] ?? request.headers["x-request-id"]
      ),
    logger: config.isTest
      ? false
      : {
          level: process.env.LOG_LEVEL ?? "info",
          redact: {
            paths: [
              "req.headers.authorization",
              "req.headers.cookie",
              "authorization",
              "cookie",
              "token",
              "accessToken",
              "refreshToken",
              "signedXdr",
              "transactionXdr",
              "privateKey",
              "secret",
              "password",
              "body.token",
              "body.signedXdr",
              "body.transactionXdr",
              "body.privateKey",
              "body.password",
            ],
            censor: "[REDACTED]",
          },
          transport:
            config.NODE_ENV === "development"
              ? { target: "pino-pretty", options: { colorize: true } }
              : undefined,
        },
    bodyLimit: 6 * 1024 * 1024,
  });

  app.addHook("onRequest", async (request, reply) => {
    const correlationId = getCorrelationId(request.id);
    reply.header("x-request-id", correlationId);
    reply.header("x-correlation-id", correlationId);
    request.log.info({ correlationId }, "request received");
  });

  app.addHook("onResponse", async (request, reply) => {
    const correlationId = getCorrelationId(request.id);
    reply.header("x-request-id", correlationId);
    reply.header("x-correlation-id", correlationId);
    request.log.info(
      {
        correlationId,
        statusCode: reply.statusCode,
        method: request.method,
        route: request.routeOptions.url,
      },
      "request completed"
    );
  });

  app.addHook("onError", async (request, _reply, error) => {
    request.log.error(
      {
        correlationId: getCorrelationId(request.id),
        statusCode: (error as Error & { statusCode?: number }).statusCode ?? 500,
        errorCode: (error as { code?: string }).code ?? "INTERNAL_ERROR",
      },
      "request failed"
    );
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  const allowAll = config.WEB_URL === "*";
  const allowed = config.WEB_URL
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const allowVercelPreviews = allowed.some((o) => o.endsWith(".vercel.app"));
  await app.register(cors, {
    origin: allowAll
      ? true
      : (origin, cb) => {
          if (!origin) return cb(null, true);
          const normalized = origin.replace(/\/+$/, "");
          if (allowed.includes(normalized)) return cb(null, true);
          if (allowVercelPreviews && normalized.endsWith(".vercel.app")) {
            return cb(null, true);
          }
          return cb(null, false);
        },
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

  await app.register(fastifyStatic, {
    root: path.resolve(config.UPLOADS_DIR),
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(authPlugin);
  await app.register(errorHandlerPlugin);

  app.setNotFoundHandler((req, reply) => {
    const correlationId = getCorrelationId(req.id);
    reply.header("x-request-id", correlationId);
    reply.header("x-correlation-id", correlationId);
    reply.code(404).send({
      error: "NOT_FOUND",
      message: "Route not found",
      statusCode: 404,
      requestId: correlationId,
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    network: config.STELLAR_NETWORK,
    time: new Date().toISOString(),
  }));

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
