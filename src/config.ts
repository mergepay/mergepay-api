import "dotenv/config";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";

const schema = z.object({
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/mergepay"),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.string().default("http://localhost:4000"),
  // "*" opens CORS to all origins; comma-separate for a whitelist e.g. "https://a.com,https://b.com"
  WEB_URL: z.string().default("*"),
  JWT_SECRET: z.string().default("change-me-in-production"),
  STELLAR_NETWORK: z.enum(["testnet", "public"]).default("public"),
  HORIZON_URL: z.string().default("https://horizon.stellar.org"),
  FEE_CACHE_TTL: z.coerce.number().positive().default(30),
  MAX_FEE_STROOPS: z.coerce.number().int().positive().default(1000),
  DEFAULT_FEE_STROOPS: z.coerce.number().int().positive().default(100),
  SEP10_SIGNING_SECRET: z.string().optional(),
  // If not set, derived from API_PUBLIC_URL so the deployed domain is used automatically.
  SEP10_HOME_DOMAIN: z.string().optional(),
  WEB_AUTH_DOMAIN: z.string().optional(),
  ANCHOR_HOME_DOMAIN: z.string().default("testanchor.stellar.org"),
  ANCHOR_NAME: z.string().default("Stellar Test Anchor"),
  ANCHOR_WEBHOOK_SECRET: z.string().default("change-me"),
  STABLE_ASSET_CODE: z.string().default("USDC"),
  STABLE_ASSET_ISSUER: z
    .string()
    .default("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
  UPLOADS_DIR: z.string().default("./uploads"),
  WORKER_INTERVAL_MS: z.coerce.number().positive().default(30000),
  NODE_ENV: z.string().default("development"),

  // Security-sensitive endpoint policies.
  RATE_LIMIT_STORE: z.enum(["memory", "database"]).default("memory"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().max(100000).default(100),
  RATE_LIMIT_ANCHOR_WEBHOOK_MAX: z.coerce.number().int().positive().max(100000).default(50),
  RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_AUTH_CHALLENGE_MAX: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_AUTH_VERIFY_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_AUTH_VERIFY_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_SETTLEMENT_CREATE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_SETTLEMENT_CONFIRM_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  SEP24_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  SEP24_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GROUP: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_HISTORY: z.coerce.number().int().positive().max(100000).default(30),
  // trusted proxies: only trust X-Forwarded-For if the direct peer is in this
  // comma-separated list; otherwise Fastify falls back to req.ip = socket remote.
  TRUSTED_PROXY_IPS: z.string().default(""),
  // Anchor circuit breaker: open after this many consecutive failures.
  ANCHOR_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  // Anchor circuit breaker cooldown before transitioning to half-open (ms).
  ANCHOR_CIRCUIT_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  AUTH_BODY_LIMIT_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(256 * 1024),
  MULTIPART_FILE_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .default(5 * 1024 * 1024),
});

const parsed = schema.parse(process.env);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "localhost:4000";
  }
}

const apiHost = hostOf(parsed.API_PUBLIC_URL);

export function validateAssetConfig() {
  if (
    !parsed.STABLE_ASSET_ISSUER ||
    parsed.STABLE_ASSET_ISSUER === "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
  ) {
    throw new Error(
      "STABLE_ASSET_ISSUER is not configured. Set it in the environment to a real issuer public key."
    );
  }
}

const networkPassphrase =
  parsed.STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET;

export const config = {
  ...parsed,
  SEP10_HOME_DOMAIN: parsed.SEP10_HOME_DOMAIN ?? apiHost,
  WEB_AUTH_DOMAIN: parsed.WEB_AUTH_DOMAIN ?? apiHost,
  isTest: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  networkPassphrase,
  jwtExpiresIn: "12h" as const,
};

export type Config = typeof config;
