import type { FastifyCorsOptions } from "@fastify/cors";

/**
 * CORS policy for the Mergepay API.
 *
 * `src/app.ts` registers `@fastify/cors` with the options built here. Every
 * knob comes from the environment (see `src/config.ts` and the CORS section of
 * `.env.example`), so pointing the frontend (`mergepay-web`) at a deployment —
 * or separating staging from production — is configuration, not code.
 *
 * The policy, in short:
 *
 * - **Origins are an explicit allow-list** taken from `WEB_URL`. Nothing is
 *   allowed by default: an empty `WEB_URL` denies every cross-origin request,
 *   which is the only safe default for an API whose requests carry bearer
 *   credentials. `"*"` reflects any origin and is for local development only.
 * - **Requests without an `Origin` header** (same-origin navigations, curl,
 *   service-to-service calls) are not cross-origin claims to check, so they
 *   pass through and the route's own authentication decides the rest.
 * - **Credentials are opt-in** via `CORS_ALLOW_CREDENTIALS`, and must never be
 *   combined with `WEB_URL="*"` outside local development: reflecting every
 *   origin while allowing credentials lets any site make authenticated
 *   requests on a user's behalf.
 * - **Methods and headers are restricted** to the configured lists rather than
 *   echoed from the request.
 * - **The preflight is answered in the plugin's `onRequest` hook**, before
 *   authentication and rate limiting, because a browser never sends an
 *   `Authorization` header on a preflight: a guard that rejected it would be
 *   refusing the very permission the browser is asking for.
 */

/** The environment variables that shape the CORS policy. */
export interface CorsEnvironment {
  /** Comma-separated origin allow-list, or `"*"` (development only). */
  WEB_URL: string;
  /** Whether cross-origin requests may carry credentials. */
  CORS_ALLOW_CREDENTIALS: boolean;
  /** Comma-separated methods advertised on a preflight. */
  CORS_ALLOW_METHODS: string;
  /** Comma-separated request headers a cross-origin request may send. */
  CORS_ALLOW_HEADERS: string;
  /** Comma-separated response headers made readable to the caller. */
  CORS_EXPOSE_HEADERS: string;
  /** Preflight cache lifetime in seconds (`Access-Control-Max-Age`). */
  CORS_MAX_AGE: number;
}

/** Split a comma-separated variable into trimmed, non-empty entries. */
function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Strip trailing slashes so `https://a.example/` and `https://a.example` match. */
function normalizeOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/** The origin rule derived from `WEB_URL`, in a form the plugin can evaluate. */
export interface OriginPolicy {
  /** `WEB_URL="*"` — every origin is allowed (development only). */
  allowAll: boolean;
  /** Normalized allow-list of origins from `WEB_URL`. */
  origins: string[];
  /**
   * `WEB_URL` names a `*.vercel.app` host, so preview deployments of the
   * frontend (`mergepay-web-*.vercel.app`) are allowed too. Without this every
   * preview URL would need its own entry in the allow-list.
   */
  allowVercelPreviews: boolean;
}

/** Derive the origin policy from `WEB_URL`. */
export function originPolicy(webUrl: string): OriginPolicy {
  const origins = parseList(webUrl).map(normalizeOrigin).filter(Boolean);
  return {
    allowAll: webUrl === "*",
    origins,
    allowVercelPreviews: origins.some((origin) => origin.endsWith(".vercel.app")),
  };
}

/** Whether `origin` may read a response cross-origin (and pass a preflight). */
export function isOriginAllowed(origin: string | undefined, policy: OriginPolicy): boolean {
  // No `Origin` header means this is not a cross-origin request at all:
  // same-origin navigations and non-browser clients land here, and the route's
  // own authentication is what governs them.
  if (!origin) return true;
  if (policy.allowAll) return true;
  const normalized = normalizeOrigin(origin);
  if (policy.origins.includes(normalized)) return true;
  return policy.allowVercelPreviews && normalized.endsWith(".vercel.app");
}

/**
 * Build the `@fastify/cors` registration options from the environment.
 *
 * Every option that matters for security or for browser behaviour is set
 * explicitly rather than left to the plugin's defaults, so the effective
 * policy is readable in one place.
 */
export function buildCorsOptions(env: CorsEnvironment): FastifyCorsOptions {
  const policy = originPolicy(env.WEB_URL);
  // Methods are compared case-insensitively by convention, so advertise them
  // uppercase whatever the deployment wrote.
  const methods = parseList(env.CORS_ALLOW_METHODS).map((method) => method.toUpperCase());
  const allowedHeaders = parseList(env.CORS_ALLOW_HEADERS);
  const exposedHeaders = parseList(env.CORS_EXPOSE_HEADERS);

  const options: FastifyCorsOptions = {
    // A function, so the allow-list is the single source of truth: returning
    // `false` makes the plugin omit every CORS header, which is exactly what a
    // disallowed origin must see — the browser then refuses to expose the
    // response to the caller.
    origin: (origin, callback) => callback(null, isOriginAllowed(origin, policy)),
    credentials: env.CORS_ALLOW_CREDENTIALS,
    maxAge: env.CORS_MAX_AGE,
    // Preflight handling, spelled out instead of left to plugin defaults:
    // answer in `onRequest` (ahead of auth and rate limiting), terminate the
    // preflight with 204 rather than passing it to a route, keep it hidden
    // from the OpenAPI document, and reject a malformed preflight — one
    // missing `Origin` or `Access-Control-Request-Method` — with 400.
    hook: "onRequest",
    preflight: true,
    preflightContinue: false,
    optionsSuccessStatus: 204,
    strictPreflight: true,
    hideOptionsRoute: true,
  };

  // An empty list means the variable was set to nothing: fall back to the
  // plugin's own default instead of advertising an empty header. (An empty
  // `allowedHeaders` falls back to echoing the requested headers, which is the
  // plugin's default and still bounded by the preflight itself.)
  if (methods.length > 0) options.methods = methods;
  if (allowedHeaders.length > 0) options.allowedHeaders = allowedHeaders;
  if (exposedHeaders.length > 0) options.exposedHeaders = exposedHeaders;

  return options;
}
