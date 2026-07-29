import "dotenv/config";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";

const schema = z.object({
  DATABASE_URL: z.string().default("postgresql://postgres:postgres@localhost:5432/mergepay"),
  PORT: z.coerce.number().default(4000),
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

  // -- rate limiting ----------------------------------------------------------
  // "memory" (default) keeps per-instance counters and is fine for a single
  // API process. "database" persists counters in Postgres so limits are
  // shared across multiple instances behind a load balancer; it adds a query
  // per rate-limited request and fails OPEN (requests are allowed through)
  // if that query errors, so a database outage degrades to "unlimited" rather
  // than "everything blocked".
  RATE_LIMIT_STORE: z.enum(["memory", "database"]).default("memory"),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AUTH_CHALLENGE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_AUTH_VERIFY_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_AUTH_VERIFY_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_SETTLEMENT_CREATE_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_SETTLEMENT_CONFIRM_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_ANCHOR_WEBHOOK_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
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

export const config = {
  ...parsed,
  SEP10_HOME_DOMAIN: parsed.SEP10_HOME_DOMAIN ?? apiHost,
  WEB_AUTH_DOMAIN: parsed.WEB_AUTH_DOMAIN ?? apiHost,
  isTest: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  networkPassphrase:
    parsed.STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET,
  jwtExpiresIn: "12h" as const,
};

export type Config = typeof config;
