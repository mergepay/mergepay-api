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
  // CORS allowlist. "*" allows any origin; otherwise a comma-separated whitelist.
  // Trailing slashes are stripped so "https://app.com/" still matches the
  // browser-sent origin "https://app.com". Vercel preview deploys (*.vercel.app)
  // are also allowed when the configured origin is itself a vercel.app domain.
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
          // Same-origin / server-to-server requests have no Origin header.
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

  // Serve uploaded receipts.
  await app.register(fastifyStatic, {
    root: path.resolve(config.UPLOADS_DIR),
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(authPlugin);

  // ---------------------------------------------------------------------------
  // Centralised error handler — produces the standard error envelope:
  //
  //   {
  //     error:      string,   // machine-readable code  (e.g. "NOT_FOUND")
  //     message:    string,   // human-readable description
  //     statusCode: number,   // HTTP status (mirrors the response status)
  //     details?:   unknown,  // structured detail payload (e.g. Zod issues)
  //     requestId:  string    // Fastify request.id for correlation / tracing
  //   }
  //
  // Registered BEFORE routes so all encapsulated plugins inherit it.
  // ---------------------------------------------------------------------------
  app.setErrorHandler((err, req, reply) => {
    const requestId = req.id as string;

    // -- Zod validation errors ------------------------------------------------
    if (err instanceof ZodError) {
      const details = err.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
        code: e.code,
      }));
      const first = err.errors[0];
      const field = first?.path.join(".");
      const message = field ? `${field}: ${first.message}` : first?.message ?? "Validation failed";

      return reply.code(400).send({
        error: "VALIDATION_ERROR",
        message,
        statusCode: 400,
        details,
        requestId,
      });
    }

    // -- Known application errors ---------------------------------------------
    if (err instanceof AppError) {
      const body: Record<string, unknown> = {
        error: err.code,
        message: err.message,
        statusCode: err.status,
        requestId,
      };
      if (err.details !== undefined) {
        body.details = err.details;
      }
      return reply.code(err.status).send(body);
    }

    // -- Rate-limit (injected by @fastify/rate-limit) -------------------------
    if ((err as any).statusCode === 429) {
      return reply.code(429).send({
        error: "RATE_LIMITED",
        message: "Too many requests, slow down.",
        statusCode: 429,
        requestId,
      });
    }

    // -- Other Fastify / plugin 4xx errors ------------------------------------
    if ((err as any).statusCode && (err as any).statusCode < 500) {
      const status: number = (err as any).statusCode;
      return reply.code(status).send({
        error: "BAD_REQUEST",
        message: err.message,
        statusCode: status,
        requestId,
      });
    }

    // -- Unexpected / unhandled errors (5xx) ----------------------------------
    // Log the full error server-side; never leak stack traces to the client.
    app.log.error({ err, requestId }, "Unhandled error");
    return reply.code(500).send({
      error: "INTERNAL_ERROR",
      message: "Something went wrong.",
      statusCode: 500,
      requestId,
    });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({
      error: "NOT_FOUND",
      message: "Route not found",
      statusCode: 404,
      requestId: req.id as string,
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
