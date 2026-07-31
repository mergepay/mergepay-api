import "dotenv/config";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";

// URL validation helper
const urlSchema = z.string().url("Invalid URL format");

// Stellar public key validation (G followed by 56 base32 characters)
const stellarPublicKeySchema = z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar public key format");

const schema = z.object({
  // Required core configuration
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: urlSchema,
  // "*" opens CORS to all origins; comma-separate for a whitelist e.g. "https://a.com,https://b.com"
  WEB_URL: z.string().default("*"),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  
  // Stellar configuration - required
  STELLAR_NETWORK: z.enum(["testnet", "public"], {
    errorMap: () => ({ message: "STELLAR_NETWORK must be either 'testnet' or 'public'" }),
  }),
  HORIZON_URL: urlSchema,
  
  // Fee configuration with sensible defaults
  FEE_CACHE_TTL: z.coerce.number().positive().default(30),
  MAX_FEE_STROOPS: z.coerce.number().int().positive().default(1000),
  DEFAULT_FEE_STROOPS: z.coerce.number().int().positive().default(100),
  
  // SEP-10 configuration - optional but validated if provided
  SEP10_SIGNING_SECRET: z.string().optional(),
  // If not set, derived from API_PUBLIC_URL so the deployed domain is used automatically.
  SEP10_HOME_DOMAIN: z.string().optional(),
  WEB_AUTH_DOMAIN: z.string().optional(),
  
  // Anchor configuration
  ANCHOR_HOME_DOMAIN: z.string().min(1, "ANCHOR_HOME_DOMAIN is required"),
  ANCHOR_NAME: z.string().min(1, "ANCHOR_NAME is required"),
  ANCHOR_WEBHOOK_SECRET: z.string().min(1, "ANCHOR_WEBHOOK_SECRET is required"),
  
  // Stable asset configuration
  STABLE_ASSET_CODE: z.string().min(1, "STABLE_ASSET_CODE is required"),
  STABLE_ASSET_ISSUER: stellarPublicKeySchema,
  
  // File storage
  UPLOADS_DIR: z.string().default("./uploads"),
  
  // Worker configuration
  WORKER_INTERVAL_MS: z.coerce.number().positive().default(30000),
  CONFIRM_POLL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  CONFIRM_POLL_DELAY_MS: z.coerce.number().int().positive().default(1500),
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
}).refine(
  (data) => {
    // Validate that HORIZON_URL matches the network
    const isTestnet = data.STELLAR_NETWORK === "testnet";
    const horizonUrl = data.HORIZON_URL.toLowerCase();
    
    if (isTestnet && !horizonUrl.includes("testnet")) {
      return false;
    }
    if (!isTestnet && horizonUrl.includes("testnet")) {
      return false;
    }
    return true;
  },
  {
    message: "HORIZON_URL must match STELLAR_NETWORK (testnet URLs for testnet, public URLs for public)",
    path: ["HORIZON_URL"],
  }
);

function safeErrorMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issues = error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "configuration";
      return `${path}: ${issue.message}`;
    });
    return issues.join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

let parsed: z.infer<typeof schema>;
try {
  parsed = schema.parse(process.env);
} catch (error) {
  const message = safeErrorMessage(error);
  console.error(`\n❌ Configuration validation failed:\n  ${message}\n`);
  console.error("Please check your environment variables and try again.\n");
  process.exit(1);
}

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
  API_URL: parsed.API_PUBLIC_URL,
  SEP10_HOME_DOMAIN: parsed.SEP10_HOME_DOMAIN ?? apiHost,
  WEB_AUTH_DOMAIN: parsed.WEB_AUTH_DOMAIN ?? apiHost,
  isTest: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  networkPassphrase,
  jwtExpiresIn: "12h" as const,
};

export type Config = typeof config;