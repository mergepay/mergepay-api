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
import { rateLimitPolicies } from "./lib/rate-limit";
import { validateAssetConfig } from "./services/assets";
import { PrismaRateLimitStore } from "./services/rate-limit-store";
import { getReadiness } from "./services/health";

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
  //
  // Rate limiting is skipped entirely under NODE_ENV=test/VITEST so route
  // tests never depend on a shared counter or on wall-clock windows; the
  // policies themselves are covered by tests/rate-limit-*.test.ts.
  if (!config.isTest) {
    const useDatabaseStore = config.RATE_LIMIT_STORE === "database";
    const globalPolicy = rateLimitPolicies().global;
    await app.register(rateLimit, {
      max: globalPolicy.max,
      timeWindow: globalPolicy.timeWindow,
      keyGenerator: globalRateLimitKey,
      ...(useDatabaseStore
        ? { store: PrismaRateLimitStore as never, skipOnError: true }
        : {}),
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
        "retry-after": true,
      },
      // 429s use the same envelope as every other API error, and never say
      // anything about the caller's identity or whether an account exists.
      errorResponseBuilder: (request, context) => ({
        error: "RATE_LIMITED",
        message: "Too many requests. Please retry later.",
        statusCode: 429,
        details: { retryAfterSeconds: Math.ceil(Number(context.ttl ?? 0) / 1000) },
        requestId: getCorrelationId(request.id),
      }),
    });
  }
  await app.register(multipart, {
    limits: {
      fileSize: config.MULTIPART_FILE_SIZE_BYTES,
      files: 1,
      parts: 10,
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
  ]);

  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;
    const options = routeOptions as typeof routeOptions & { bodyLimit?: number };

    if (url === "/uploads/receipt") {
      options.bodyLimit = config.MULTIPART_FILE_SIZE_BYTES + 64 * 1024;
    } else if (BODY_LIMITED_ROUTES.has(url)) {
      options.bodyLimit = config.AUTH_BODY_LIMIT_BYTES;
    }
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

  // Liveness: process is up. Deliberately touches no dependency so a database
  // or Horizon outage never causes an orchestrator to restart healthy pods.
  app.get("/health/live", async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  }));

  // Readiness: dependencies are usable. Results are cached briefly inside
  // src/services/health.ts so probes cannot amplify into upstream load.
  app.get("/health/ready", async (_req, reply) => {
    const readiness = await getReadiness();
    return reply.code(readiness.status === "ok" ? 200 : 503).send(readiness);
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

  return app;
}
