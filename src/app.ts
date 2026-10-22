import Fastify, { FastifyInstance, FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import path from "node:path";
import { config } from "./config";
import authPlugin from "./plugins/auth";
import groupAccessPlugin from "./plugins/group-access";
import errorHandlerPlugin from "./plugins/error-handler";
import idempotencyPlugin from "./plugins/idempotency";
import loggingPlugin from "./plugins/logging";
import openAPIPlugin from "./plugins/openapi";
import rateLimitPlugin, { type RateLimitRegistration } from "./plugins/rate-limit";
import requestTimeoutPlugin from "./plugins/request-timeout";
import { validateAssetConfig } from "./services/assets";
import authRoutes from "./routes/auth";
import groupRoutes from "./routes/groups";
import expenseRoutes from "./routes/expenses";
import settlementRoutes from "./routes/settlements";
import treasuryRoutes from "./routes/treasury";
import treasuryProposalRoutes from "./routes/treasury-proposals";
import treasurySignatureRoutes from "./routes/treasury-signatures";
import treasuryMultisigRoutes from "./routes/treasury-multisig";
import anchorRoutes from "./routes/anchors";
import withdrawalRoutes from "./routes/withdraw";
import historyRoutes from "./routes/history";
import uploadRoutes from "./routes/uploads";
import auditLogRoutes from "./routes/audit-log";
import sep24Routes from "./routes/sep24";
import webhookRoutes from "./routes/webhooks";
import exchangeRateRoutes from "./routes/exchange-rates";
import userGroupsRoutes from "./routes/user-groups";
import healthRoutes from "./routes/health";
import { getCorrelationId } from "./lib/correlation";
import { formatErrorResponse } from "./utils/error-response";
import { buildLoggerOptions, nullLogDestination } from "./lib/logger";
import { buildCorsOptions } from "./lib/cors";
import { getReadiness } from "./services/health";
import { installMultipartGuard } from "./lib/multipart-guard";
import { nanoid } from "nanoid";

/**
 * Build-time overrides.
 *
 * `logger` exists so tests can inject a Pino instance that writes into an
 * in-memory stream: without an injection point there would be nothing for the
 * error-handling tests to assert against. Production callers pass no options
 * and keep the configured logger.
 */
export interface BuildAppOptions {
  logger?: FastifyServerOptions["logger"];
  /**
   * Observes every route as it is declared, before the route plugins below
   * register it.
   *
   * Route plugins are loaded while `buildApp` is still awaiting its own
   * `register` calls, so a hook attached to the returned instance is always too
   * late — this is the only place a caller can see the declarations. It exists
   * for tests/rate-limit-wiring.test.ts, which audits which policy each route
   * names. Production callers pass nothing.
   */
  onRoute?: (routeOptions: {
    method?: string | string[];
    url?: string;
    config?: Record<string, unknown>;
  }) => void;
  /**
   * Throttle mode for this instance; defaults to `"enforced"`.
   *
   * `"off"` boots the app with no rate limiter. A suite that reuses one
   * `buildApp()` across many requests needs it: authenticated budgets key on the
   * user, not the client address, so rotating `remoteAddress` does not buy a
   * fresh budget and a long database-backed file can run one actor's tier out and
   * then fail an unrelated assertion with a 429. Only a suite whose subject is
   * *not* the limiter should pass this — the limiter's own suites, and every
   * production caller, keep the default. See src/plugins/rate-limit.ts.
   */
  rateLimit?: RateLimitRegistration;
  /**
   * Request timeout for this instance, in milliseconds; defaults to
   * `config.REQUEST_TIMEOUT_MS`.
   *
   * Exists so a suite can prove the timeout without waiting the production
   * budget out. A test that injects a deliberately slow route passes a few
   * milliseconds and asserts the 408; production callers pass nothing and keep
   * the configured value. See src/plugins/request-timeout.ts.
   */
  requestTimeoutMs?: number;
}

/**
 * Versioned base path every domain route is mounted under (issue #386).
 *
 * The version lives in the registration, not in each route file, so the
 * version bump is one edit here rather than one per `app.get(...)` call.
 * Operational endpoints — health probes, the OpenAPI docs, and the static
 * `/uploads/` file server — deliberately stay at the root; a client's
 * liveness probe should not have to track the API version.
 */
export const API_V1_PREFIX = "/api/v1";

/**
 * Legacy API path prefixes that keep resolving while clients migrate onto
 * {@link API_V1_PREFIX}.
 *
 * Before versioning, domain routes lived at these root paths (and a handful of
 * newer ones under `/api/...`). Fastify's `rewriteUrl` maps those requests onto
 * the versioned route table, so an existing client keeps working after this
 * change while a new one targets `/api/v1` explicitly. Every entry is a real
 * past route prefix: a request outside this set — a test route, a typo, a
 * probe — is never rewritten and still answers 404 from wherever it pointed.
 */
const LEGACY_API_PATH_PREFIXES = [
  "/auth",
  "/me",
  "/groups",
  "/expenses",
  "/settlements",
  "/treasury",
  "/treasury-transactions",
  "/anchors",
  "/withdraw",
  "/history",
  "/users",
  // The upload endpoint moved under the version prefix while its served files
  // stayed at /uploads/<file>; only the endpoint path is rewritten.
  "/uploads/receipt",
] as const;

/**
 * Map a legacy request path onto its versioned equivalent, preserving the
 * query string. Anything already versioned, operational, or unknown is
 * returned untouched.
 */
export function toVersionedUrl(rawUrl: string): string {
  const queryAt = rawUrl.indexOf("?");
  const pathname = queryAt === -1 ? rawUrl : rawUrl.slice(0, queryAt);
  const search = queryAt === -1 ? "" : rawUrl.slice(queryAt);

  if (pathname === API_V1_PREFIX || pathname.startsWith(`${API_V1_PREFIX}/`)) {
    return rawUrl;
  }

  // Paths that were already namespaced, just without a version: /api/sep24/x
  // becomes /api/v1/sep24/x. Checked before the root-prefix list below so an
  // entry like /api/exchange-rates never becomes /api/v1/api/exchange-rates.
  if (pathname.startsWith("/api/")) {
    return `${API_V1_PREFIX}${pathname.slice("/api".length)}${search}`;
  }

  const isLegacyDomainPath = LEGACY_API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  return isLegacyDomainPath ? `${API_V1_PREFIX}${pathname}${search}` : rawUrl;
}

/**
 * Strip the version prefix from a registered route URL, if present.
 *
 * `onRoute` sees the URL after the registration prefix has been applied, while
 * the tables in this file are written against route-relative paths. Normalising
 * here keeps `BODY_LIMITED_ROUTES` readable and correct no matter which prefix
 * a route plugin was registered under.
 */
function stripApiVersion(url: string): string {
  if (url === API_V1_PREFIX) return "/";
  return url.startsWith(`${API_V1_PREFIX}/`)
    ? url.slice(API_V1_PREFIX.length)
    : url;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  validateAssetConfig();

  // Contains a @fastify/busboy defect that turns a truncated multipart body
  // into an uncaught exception. See src/lib/multipart-guard.ts.
  installMultipartGuard();

  // The logger is configured from the shared option set in src/lib/logger.ts so
  // the request, response, and error serializers apply to every log line this
  // instance emits — including the "incoming request" / "request completed"
  // lines Fastify writes itself, which are the ones that would otherwise carry
  // a raw Authorization header into the log.
  //
  // Under test the same configuration is used, only pointed at a destination
  // that discards its input: the serializers run on every request the suite
  // makes, so one that throws — or a credential that slips past redaction —
  // fails `npm test`, while the run itself stays quiet.
  const loggerOptions = buildLoggerOptions({
    level: config.LOG_LEVEL,
    pretty: config.NODE_ENV === "development" && !config.isTest,
  });

  const app = Fastify({
    requestIdHeader: "x-request-id",
    // Legacy path compatibility for the /api/v1 migration (issue #386). Runs
    // before routing, so the route table itself contains only versioned paths
    // while old clients keep reaching them.
    rewriteUrl: (request) => toVersionedUrl(request.url ?? "/"),
    genReqId: (request) => {
      const incomingRequestId = request.headers["x-request-id"];
      const incomingCorrelationId = request.headers["x-correlation-id"];
      const preferred =
        typeof incomingRequestId === "string" && incomingRequestId.trim()
          ? incomingRequestId
          : typeof incomingCorrelationId === "string" && incomingCorrelationId.trim()
            ? incomingCorrelationId
            : `req-${nanoid(16)}`;

      return getCorrelationId(preferred);
    },
    logger:
      options.logger ??
      (config.isTest
        ? { ...loggerOptions, stream: nullLogDestination() }
        : loggerOptions),
    bodyLimit: config.JSON_BODY_LIMIT_BYTES,
    ajv: {
      customOptions: {
        // Fastify's default is `coerceTypes: 'array'`, which quietly rewrites a
        // value to the type the route schema declares before any handler sees
        // it: a JSON number sent for a string field arrives as "12345". Every
        // request body in this API is validated by a Zod schema that reports
        // the field, the rule, and the value's real type, and coercion would
        // rob it of the last of those — a client sending a number for
        // `transaction` would be told its base64 was malformed rather than
        // that it was not a string. Validation belongs to the Zod layer, so
        // ajv is left describing payloads, not rewriting them.
        coerceTypes: false,
      },
    },
  });

  // Declared before any plugin below registers a route, so it observes the
  // whole table. See BuildAppOptions.onRoute.
  if (options.onRoute) {
    app.addHook("onRoute", options.onRoute);
  }

  // Bounds the whole pipeline — auth, validation, handler, upstream and
  // database work — and answers an overrun with 408. Registered before the
  // route plugins so its `onRequest` hook is inherited by every route they
  // declare, including any test route added afterwards.
  await app.register(requestTimeoutPlugin, {
    timeoutMs: options.requestTimeoutMs ?? config.REQUEST_TIMEOUT_MS,
  });

  app.addHook("onRequest", async (request, reply) => {
    const requestId = request.id;
    const correlationId = getCorrelationId(requestId);
    reply.header("x-request-id", requestId);
    reply.header("x-correlation-id", correlationId);
    request.log = request.log.child({ reqId: requestId, correlationId });
    request.log.info({ requestId, correlationId }, "request received");
  });

  app.addHook("onResponse", async (request, reply) => {
    const requestId = request.id;
    const correlationId = getCorrelationId(requestId);
    reply.header("x-request-id", requestId);
    reply.header("x-correlation-id", correlationId);
    request.log = request.log.child({ reqId: requestId, correlationId });
    request.log.info(
      {
        requestId,
        correlationId,
        statusCode: reply.statusCode,
        method: request.method,
        route: request.routeOptions.url,
      },
      "request completed"
    );
  });

  app.addHook("onError", async (request, _reply, error) => {
    // A handler is not obliged to throw an `Error`: `throw null` and a promise
    // rejected with no reason (`Promise.reject()`) both surface here as
    // nullish. Reading `.statusCode` off nullish throws a TypeError *inside this
    // hook*, which aborts the error pipeline before the central handler can
    // answer — leaving Fastify's built-in handler to emit a payload that has
    // neither the standard envelope nor a requestId. Reading through a
    // nullish-safe view keeps the pipeline alive so the handler can answer on
    // the normal contract.
    const thrown = (error ?? {}) as unknown as Record<string, unknown>;
    const statusCode = (thrown.statusCode as number) ?? (thrown.status as number) ?? 500;
    const errorCode = (thrown.code as string) ?? "INTERNAL_ERROR";
    const correlationId = getCorrelationId(request.id);

    const logData: Record<string, unknown> = {
      correlationId,
      statusCode,
      errorCode,
    };
    if (statusCode >= 500) {
      // Include the error object (and its stack) for unexpected server faults.
      request.log.error({ ...logData, err: error }, "request failed");
    } else {
      // Client errors are expected rejections: warn level, no stack.
      request.log.warn(logData, "request failed");
    }
  });

  // Security headers via @fastify/helmet.
  // Explicit production-ready helmet options configured for API security while
  // ensuring Swagger UI documentation (/docs) remains fully functional.
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https:", "data:"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        imgSrc: ["'self'", "data:", "validator.swagger.io"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        upgradeInsecureRequests: [],
      },
    },
    frameguard: { action: "deny" },
    noSniff: true,
    referrerPolicy: { policy: "no-referrer" },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: "same-origin" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
    dnsPrefetchControl: { allow: false },
    ieNoOpen: true,
    permittedCrossDomainPolicies: { permittedPolicies: "none" },
    hsts: {
      maxAge: 60 * 60 * 24 * 365,
      includeSubDomains: true,
      preload: true,
    },
  });
  // CORS — explicit, environment-driven options built by src/lib/cors.ts
  // (WEB_URL and the CORS_* variables; see .env.example). Registered here,
  // after helmet and before rate limiting, so a browser's preflight — which
  // never carries an Authorization header — is answered 204 inside the plugin's
  // onRequest hook instead of reaching an auth guard or spending rate-limit
  // budget it does not need.
  await app.register(cors, buildCorsOptions(config));
  // Rate limiting: the global default bucket plus every per-route tier. The
  // registration itself (limits, key strategy, store selection, the 429
  // envelope) lives in src/plugins/rate-limit.ts; the per-route policies live
  // in src/lib/rate-limit.ts and are named by the routes they guard. Registering
  // it here — before the route plugins, and before groupAccessPlugin below —
  // is what lets its onRoute hook append each limit to the right hook.
  //
  // `options.rateLimit` is the suite-facing escape hatch described on
  // `BuildAppOptions`: with `"off"` nothing registers, so route-level
  // `config.rateLimit` values stay inert and the app answers every request. The
  // default keeps the limiter, and production callers pass no options.
  await app.register(rateLimitPlugin, {
    rateLimit: options.rateLimit ?? "enforced",
  });
  // Multipart limits, all explicit. Only /uploads/receipt consumes a multipart
  // body (the SEP-24 anchor flow is JSON end to end), so these bound that one
  // route without touching the JSON routes, which keep their own bodyLimit.
  //
  // `throwFileSizeLimit` makes an oversized file an error the route can answer
  // rather than a silently truncated stream — a truncated receipt would other-
  // wise be written to disk as though it were complete. Each limit maps to its
  // own client error in src/lib/request-limits.ts.
  await app.register(multipart, {
    limits: {
      fileSize: config.MULTIPART_FILE_SIZE_BYTES,
      files: config.MULTIPART_MAX_FILES,
      // Bounds a single non-file field. busboy buffers field values in memory,
      // so without this a form field is an unbounded allocation.
      fieldSize: config.MULTIPART_FIELD_SIZE_BYTES,
      parts: config.MULTIPART_MAX_FIELDS,
    },
    throwFileSizeLimit: true,
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
    "/api/settlements/execute",
    "/groups/:id/treasury/deposit",
    "/groups/:id/treasury/withdraw",
    "/treasury-transactions/:id/confirm",
    "/api/treasury/proposals",
    "/api/treasury/proposals/:id/signatures",
    "/treasury/propose",
    "/treasury/:id/sign",
    "/anchors/deposit",
    "/anchors/withdraw",
    "/api/sep24/deposit",
    "/api/sep24/withdraw",
    "/anchors/sessions/:id/complete",
    "/anchors/webhook",
    "/api/webhooks/sep24",
    "/api/sep24/callback",
  ]);

  app.addHook("onRoute", (routeOptions) => {
    // Registered routes carry the /api/v1 prefix; the tables above are written
    // against route-relative paths.
    const url = stripApiVersion(routeOptions.url);

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
  // Must come after the rate-limit registration above: its onRoute hook
  // moves each group guard behind the limiter in the route's preHandler chain.
  await app.register(groupAccessPlugin);
  await app.register(errorHandlerPlugin);
  // Registered with fastify-plugin, so `app.idempotent` is visible to every
  // route plugin below rather than only inside this scope.
  await app.register(idempotencyPlugin);
  await app.register(openAPIPlugin);

  app.setNotFoundHandler((req, reply) => {
    const correlationId = getCorrelationId(req.id);
    reply.header("x-request-id", correlationId);
    reply.header("x-correlation-id", correlationId);
    reply.code(404).send(formatErrorResponse("NOT_FOUND", "Route not found", correlationId));
  });

  await app.register(healthRoutes);

  const liveness = async () => ({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
  app.get("/health/live", liveness);

  const { getDeepHealth } = await import("./services/health.js");
  app.get("/health/deep", async (request, reply) => {
    const deepHealth = await getDeepHealth();
    const statusCode = deepHealth.status === "ok" ? 200 : 503;
    return reply.code(statusCode).send(deepHealth);
  });

  // Every domain route plugin is mounted under /api/v1 (issue #386), so no
  // route file spells the version itself. Health, docs, and the static
  // /uploads/ server above stay at the root on purpose.
  await app.register(authRoutes, { prefix: API_V1_PREFIX });
  await app.register(groupRoutes, { prefix: API_V1_PREFIX });
  await app.register(expenseRoutes, { prefix: API_V1_PREFIX });
  await app.register(settlementRoutes, { prefix: API_V1_PREFIX });
  await app.register(treasuryRoutes, { prefix: API_V1_PREFIX });
  await app.register(treasuryProposalRoutes, { prefix: API_V1_PREFIX });
  await app.register(treasurySignatureRoutes, { prefix: API_V1_PREFIX });
  await app.register(treasuryMultisigRoutes, { prefix: API_V1_PREFIX });
  await app.register(anchorRoutes, { prefix: API_V1_PREFIX });
  await app.register(withdrawalRoutes, { prefix: API_V1_PREFIX });
  await app.register(historyRoutes, { prefix: API_V1_PREFIX });
  await app.register(uploadRoutes, { prefix: API_V1_PREFIX });
  await app.register(userGroupsRoutes, { prefix: API_V1_PREFIX });
  await app.register(auditLogRoutes, { prefix: API_V1_PREFIX });
  await app.register(sep24Routes, { prefix: API_V1_PREFIX });
  await app.register(webhookRoutes, { prefix: API_V1_PREFIX });
  await app.register(exchangeRateRoutes, { prefix: API_V1_PREFIX });

  return app;
}
