import "dotenv/config";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";

/** A rate-limit ceiling: a positive integer, bounded so a typo can't disable limiting. */
function rateLimitMax(fallback: number) {
  return z.coerce.number().int().positive().max(100000).default(fallback);
}

/** A rate-limit window in milliseconds; capped at one hour. */
function rateLimitWindow(fallback = 60000) {
  return z.coerce.number().int().positive().max(3600000).default(fallback);
}

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

  // ── Rate limiting ────────────────────────────────────────────────────────
  //
  // Every route is covered by the global policy; routes that do expensive
  // cryptographic work, submit to Horizon, or fan out to an anchor get their
  // own bucket so they never share a budget with ordinary authenticated
  // reads. Each value is independently overridable per deployment — see
  // .env.example and README.md#rate-limiting.
  //
  // "memory" keeps counters per API process (correct for a single instance);
  // "database" shares them across instances via the rate_limit_buckets table
  // and fails open if that store errors (src/services/rate-limit-store.ts).
  RATE_LIMIT_STORE: z.enum(["memory", "database"]).default("memory"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),

  RATE_LIMIT_GLOBAL_MAX: rateLimitMax(100),
  RATE_LIMIT_GLOBAL_WINDOW_MS: rateLimitWindow(),

  // SEP-10: a challenge is cheap and legitimately retried while a wallet
  // prompt is open; verify is the actual authentication step and is kept
  // tighter to slow brute-force attempts against it.
  RATE_LIMIT_AUTH_CHALLENGE_MAX: rateLimitMax(20),
  RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS: rateLimitWindow(),
  RATE_LIMIT_AUTH_VERIFY_MAX: rateLimitMax(10),
  RATE_LIMIT_AUTH_VERIFY_WINDOW_MS: rateLimitWindow(),

  // Settlement: creation builds and signs nothing but does load an account
  // from Horizon; confirmation validates a signed envelope and submits it.
  // Confirm is looser than create because a wallet may legitimately retry a
  // submission whose result it never saw.
  RATE_LIMIT_SETTLEMENT_CREATE_MAX: rateLimitMax(20),
  RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS: rateLimitWindow(),
  RATE_LIMIT_SETTLEMENT_CONFIRM_MAX: rateLimitMax(30),
  RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS: rateLimitWindow(),

  // Treasury signed submission — same shape of work as a settlement confirm,
  // but budgeted separately so a busy treasury cannot starve settlements.
  RATE_LIMIT_TREASURY_SUBMIT_MAX: rateLimitMax(30),
  RATE_LIMIT_TREASURY_SUBMIT_WINDOW_MS: rateLimitWindow(),

  // Anchor: initiation fans out to the anchor's stellar.toml, SEP-10, and
  // SEP-24 interactive endpoints, so it is the tightest budget in the API.
  // Polling reads are cheaper but still upstream-amplifying.
  RATE_LIMIT_ANCHOR_INIT_MAX: rateLimitMax(10),
  RATE_LIMIT_ANCHOR_INIT_WINDOW_MS: rateLimitWindow(),
  RATE_LIMIT_ANCHOR_POLL_MAX: rateLimitMax(60),
  RATE_LIMIT_ANCHOR_POLL_WINDOW_MS: rateLimitWindow(),
  // Abuse protection only — never a substitute for ANCHOR_WEBHOOK_SECRET.
  RATE_LIMIT_ANCHOR_WEBHOOK_MAX: rateLimitMax(60),
  RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS: rateLimitWindow(),

  // Ordinary authenticated work that is still worth bounding.
  RATE_LIMIT_GROUP: rateLimitMax(30),
  RATE_LIMIT_HISTORY: rateLimitMax(60),

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
