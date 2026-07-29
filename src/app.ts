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
    max: config.RATE_LIMIT_GLOBAL_MAX,
    timeWindow: config.RATE_LIMIT_GLOBAL_WINDOW_MS,
    keyGenerator: securityKey,
    addHeaders: true,
    errorResponseBuilder: (request) => ({
      error: "RATE_LIMITED",
      message: "Too many requests. Please retry later.",
      statusCode: 429,
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

  // Apply stricter policies only to expensive or abuse-prone endpoints.
  app.addHook("onRoute", (routeOptions) => {
    const url = routeOptions.url;
    let rateLimit: { max: number; timeWindow: number } | undefined;
    let bodyLimit: number | undefined;

    // Auth endpoints: challenge is more forgiving (wallet polling), verify is strict
    if (url === "/auth/challenge") {
      rateLimit = {
        max: config.RATE_LIMIT_AUTH_CHALLENGE_MAX,
        timeWindow: config.RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    } else if (url === "/auth/verify") {
      rateLimit = {
        max: config.RATE_LIMIT_AUTH_VERIFY_MAX,
        timeWindow: config.RATE_LIMIT_AUTH_VERIFY_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    }
    // Settlement endpoints: create/initiate is more restricted than confirm
    else if (url === "/expenses/:id/settle" || url === "/groups/:id/settlements") {
      rateLimit = {
        max: config.RATE_LIMIT_SETTLEMENT_CREATE_MAX,
        timeWindow: config.RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    } else if (url === "/settlements/:id/confirm" || url === "/settlements/:id/submit") {
      rateLimit = {
        max: config.RATE_LIMIT_SETTLEMENT_CONFIRM_MAX,
        timeWindow: config.RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    }
    // SEP-24 anchor endpoints: initiate/status distinction
    else if (url === "/anchors/deposit" || url === "/anchors/withdraw") {
      rateLimit = {
        max: config.RATE_LIMIT_ANCHOR_INITIATE_MAX,
        timeWindow: config.RATE_LIMIT_ANCHOR_INITIATE_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    } else if (url === "/anchors/sessions/:id/complete" || url === "/anchors/sessions") {
      rateLimit = {
        max: config.RATE_LIMIT_ANCHOR_STATUS_MAX,
        timeWindow: config.RATE_LIMIT_ANCHOR_STATUS_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    } else if (url === "/anchors/webhook") {
      rateLimit = {
        max: config.RATE_LIMIT_ANCHOR_WEBHOOK_MAX,
        timeWindow: config.RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS,
      };
      bodyLimit = config.JSON_BODY_LIMIT_BYTES;
    }
    // File uploads: large multipart bodies allowed
    else if (url === "/uploads/receipt") {
      rateLimit = {
        max: config.RATE_LIMIT_ANCHOR_INITIATE_MAX,
        timeWindow: config.RATE_LIMIT_ANCHOR_INITIATE_WINDOW_MS,
      };
      bodyLimit = config.MULTIPART_FILE_SIZE_BYTES + 64 * 1024;
    }

    if (rateLimit !== undefined) {
      const options = routeOptions as typeof routeOptions & {
        config?: Record<string, unknown>;
        bodyLimit?: number;
      };
      options.config = {
        ...(options.config ?? {}),
        rateLimit: {
          max: rateLimit.max,
          timeWindow: rateLimit.timeWindow,
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
  await app.register(withdrawalRoutes);
  await app.register(historyRoutes);
  await app.register(uploadRoutes);

  return app;
}
