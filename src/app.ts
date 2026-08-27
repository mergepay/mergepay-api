import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { config } from "./config";
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
import treasuryProposalRoutes from "./routes/treasury-proposals";
import anchorRoutes from "./routes/anchors";
import withdrawalRoutes from "./routes/withdraw";
import historyRoutes from "./routes/history";
import uploadRoutes from "./routes/uploads";
import auditLogRoutes from "./routes/audit-log";
import sep24Routes from "./routes/sep24";
import webhookRoutes from "./routes/webhooks";
import userGroupsRoutes from "./routes/user-groups";
import { getCorrelationId } from "./lib/correlation";
import { rateLimitPolicies } from "./lib/rate-limit";
import { PrismaRateLimitStore } from "./services/rate-limit-store";


/**
 * Global-policy key. Unlike the per-route policies (which run on `preHandler`
 * and can read `req.user`), the global limiter runs on `onRequest`, before any
 * route's authenticate hook, so it resolves the identity from the bearer token
 * itself. An unparseable token deliberately falls back to the client IP so
 * invalid credentials share one bucket instead of minting a fresh one each try.
 */
function globalRateLimitKey(request: FastifyRequest): string {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    try {
      const user = verifyToken(authorization.slice("Bearer ".length).trim());
      return `global:user:${user.id}`;
    } catch {
      // Invalid credentials are deliberately grouped by client IP.
    }
  }
  return `global:ip:${request.ip}`;
}

export async function buildApp(): Promise<FastifyInstance> {
  validateAssetConfig();

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
    bodyLimit: config.JSON_BODY_LIMIT_BYTES,
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
  // Global default limit. Sensitive routes (SEP-10 auth, settlement and
  // treasury submission, anchor initiation and polling) override this with
  // their own bucket — see src/lib/rate-limit.ts for the policy table and the
  // routes that name each policy. Keys are the authenticated user id when
  // available, otherwise the resolved client IP — never a wallet public key.
  //
  // RATE_LIMIT_STORE=database shares counters across instances via Postgres
  // (src/services/rate-limit-store.ts) and fails OPEN if that store errors
  // (skipOnError), so a database hiccup degrades to "unlimited" rather than
  // blocking all traffic. The default "memory" store is per-process and
  // needs no failure handling of its own.
  await app.register(rateLimit, {
    global: true,
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
    keyGenerator: globalRateLimitKey,
    addHeaders: { "x-ratelimit-limit": true, "x-ratelimit-remaining": true, "x-ratelimit-reset": true, "retry-after": true } as any,
    errorResponseBuilder: (request: FastifyRequest) => ({
      code: "RATE_LIMITED",
      message: "Too many requests. Please retry later.",
      requestId: request.id,
    }),
  });
  await app.register(multipart, {
    limits: {
      fileSize: config.MULTIPART_FILE_SIZE_BYTES,
      files: config.MULTIPART_MAX_FILES,
      parts: config.MULTIPART_MAX_FIELDS,
    },
  });

  // Cap the request body on routes that take signed envelopes or credentials,
  // so a malformed or hostile payload is rejected by Fastify before any Zod
  // parsing, cryptographic work, or upstream call happens. Rate-limit policy
  // is *not* set here — each route names its own policy from
  // src/lib/rate-limit.ts, which keeps the limit next to the handler it guards.
  const BODY_LIMITED_ROUTES = new Set([
    "/auth/challenge",
    "/auth/verify",
    "/expenses/:id/settle",
    "/groups/:id/settlements",
    "/settlements/:id/confirm",
    "/groups/:id/treasury/deposit",
    "/groups/:id/treasury/withdraw",
    "/treasury-transactions/:id/confirm",
    "/anchors/deposit",
    "/anchors/withdraw",
    "/anchors/sessions/:id/complete",
    "/anchors/webhook",
    "/api/sep24/callback",
  ]);

  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;

    if (url === "/uploads/receipt") {
      routeOptions.bodyLimit = config.MULTIPART_FILE_SIZE_BYTES + 64 * 1024;
    } else if (BODY_LIMITED_ROUTES.has(url)) {
      routeOptions.bodyLimit = config.AUTH_BODY_LIMIT_BYTES;
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

  const liveness = async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
  app.get("/health", liveness);
  app.get("/health/live", liveness);

  const { getReadiness, getDeepHealth } = await import("./services/health.js");
  app.get("/health/ready", async (request, reply) => {
    const readiness = await getReadiness();
    const statusCode = readiness.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(readiness);
  });

  app.get("/health/deep", async (request, reply) => {
    const deepHealth = await getDeepHealth();
    const statusCode = deepHealth.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(deepHealth);
  });

  await app.register(authRoutes);
  await app.register(groupRoutes);
  await app.register(expenseRoutes);
  await app.register(settlementRoutes);
  await app.register(treasuryRoutes);
  await app.register(treasuryProposalRoutes);
  await app.register(anchorRoutes);
  await app.register(withdrawalRoutes);
  await app.register(historyRoutes);
  await app.register(uploadRoutes);
  await app.register(userGroupsRoutes);
  await app.register(auditLogRoutes);
  await app.register(sep24Routes);
  await app.register(webhookRoutes);

  return app;
}
