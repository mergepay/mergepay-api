import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimitPlugin from "./plugins/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { config, validateAssetConfig } from "./config";
import { verifyToken } from "./plugins/auth";
import authPlugin from "./plugins/auth";
import errorHandlerPlugin from "./plugins/error-handler";
import loggingPlugin from "./plugins/logging";
import openAPIPlugin from "./plugins/openapi";
import { validateAssetConfig } from "./services/assets";
import authRoutes from "./routes/auth";
import groupRoutes from "./routes/groups";
import expenseRoutes from "./routes/expenses";
import settlementRoutes from "./routes/settlements";
import treasuryRoutes from "./routes/treasury";
import anchorRoutes from "./routes/anchors";
import withdrawalRoutes from "./routes/withdraw";
import historyRoutes from "./routes/history";
import uploadRoutes from "./routes/uploads";
import { getCorrelationId } from "./lib/correlation";

function securityKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    try {
      return `user:${verifyToken(authorization.slice("Bearer ".length).trim()).id}`;
    } catch {
      // Invalid credentials are deliberately grouped by client IP.
    }
  }
  return `ip:${request.ip}`;
}

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
    bodyLimit: config.MULTIPART_FILE_SIZE_BYTES + 64 * 1024,
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
  // Global default limit. Sensitive routes (SEP-10 auth, settlement
  // submission, the SEP-24 callback) override this with their own,
  // route-appropriate config — see routes/auth.ts, routes/settlements.ts,
  // routes/anchors.ts. Keys are the authenticated user id when available,
  // otherwise the resolved client IP — never a wallet public key.
  //
  // RATE_LIMIT_STORE=database shares counters across instances via Postgres
  // (src/services/rate-limit-store.ts) and fails OPEN if that store errors
  // (skipOnError), so a database hiccup degrades to "unlimited" rather than
  // blocking all traffic. The default "memory" store is per-process and
  // needs no failure handling of its own.
  await app.register(rateLimit, {
    max: 100,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    keyGenerator: securityKey,
    addHeaders: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true, "retry-after": true } as any,
    errorResponseBuilder: (request) => ({
      code: "RATE_LIMITED",
      message: "Too many requests. Please retry later.",
      requestId: request.id,
    }),
  });
  await app.register(multipart, {
    limits: {
      fileSize: config.MULTIPART_FILE_SIZE_BYTES,
      files: 1,
      parts: 10,
    },
  });

  // Apply stricter policies only to expensive or abuse-prone endpoints.
  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;
    let max: number | undefined;
    let bodyLimit: number | undefined;

    if (url === "/auth/challenge" || url === "/auth/verify") {
      max = config.RATE_LIMIT_AUTH_CHALLENGE_MAX;
      bodyLimit = config.AUTH_BODY_LIMIT_BYTES;
    } else if (
      url === "/expenses/:id/settle" ||
      url === "/groups/:id/settlements" ||
      url === "/settlements/:id/confirm"
    ) {
      max = config.RATE_LIMIT_SETTLEMENT_CREATE_MAX;
      bodyLimit = config.AUTH_BODY_LIMIT_BYTES;
    } else if (
      url === "/anchors/deposit" ||
      url === "/anchors/withdraw" ||
      url === "/anchors/sessions/:id/complete" ||
      url === "/uploads/receipt"
    ) {
      max = config.SEP24_RATE_LIMIT_MAX;
      bodyLimit = url === "/uploads/receipt"
        ? config.MULTIPART_FILE_SIZE_BYTES + 64 * 1024
        : config.AUTH_BODY_LIMIT_BYTES;
    }

    if (max !== undefined) {
      const options = routeOptions as typeof routeOptions & {
        config?: Record<string, unknown>;
        bodyLimit?: number;
      };
      options.config = {
        ...(options.config ?? {}),
        rateLimit: {
          max,
          timeWindow: config.RATE_LIMIT_WINDOW_MS,
          keyGenerator: securityKey,
        },
      };
      options.bodyLimit = bodyLimit;
    }
  });

  await app.register(fastifyStatic, {
    root: path.resolve(config.UPLOADS_DIR),
    prefix: "/uploads/",
    decorateReply: false,
  });

  await app.register(loggingPlugin);
  await app.register(authPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(openAPIPlugin);

  app.setNotFoundHandler((req, reply) => {
    const correlationId = getCorrelationId(req.id);
    reply.header("x-request-id", correlationId);
    reply.header("x-correlation-id", correlationId);
    reply.code(404).send({
      code: "NOT_FOUND",
      message: "Route not found",
      requestId: correlationId,
    });
  });

  app.get("/health", async () => ({
    status: "ok",
    network: config.STELLAR_NETWORK,
    time: new Date().toISOString(),
  }));

  app.get("/healthz", async () => ({
    status: "ok",
  }));

  const { getReadiness } = await import("./services/health.js");
  app.get("/readyz", async (request, reply) => {
    const readiness = await getReadiness();
    const statusCode = readiness.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(readiness);
  });

  await app.register(authRoutes);
  await app.register(groupRoutes);
  await app.register(expenseRoutes);
  await app.register(settlementRoutes);
  await app.register(treasuryRoutes);
  await app.register(anchorRoutes);
  await app.register(withdrawalRoutes);
  await app.register(historyRoutes);
  await app.register(uploadRoutes);
  await app.register(userGroupsRoutes);

  return app;
}
