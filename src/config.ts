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
  // Bound a session to this deployment: a token minted for another environment
  // or audience is rejected even when the signing secret is shared.
  JWT_ISSUER: z.string().default("mergepay-api"),
  // Access-token lifetime. Short by design: a refresh token now covers the
  // gap, so a stolen access token stays useful for minutes rather than hours.
  // Expressed in seconds so it can be compared against the refresh TTL below.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(900),
  // Refresh-token lifetime. Bounds how long an idle session can be revived
  // without the wallet signing a new SEP-10 challenge.
  REFRESH_TOKEN_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60 * 1000),
  JWT_AUDIENCE: z.string().default("mergepay-app"),

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
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  MULTIPART_MAX_FILES: z.coerce.number().int().positive().default(1),
  MULTIPART_MAX_FIELDS: z.coerce.number().int().positive().default(20),

  // Worker configuration
  WORKER_INTERVAL_MS: z.coerce.number().positive().default(30000),
  // How long a worker's claim on a job survives without renewal. A process that
  // crashes mid-job leaves its lease behind; another worker may take the job
  // over only once the lease has lapsed.
  WORKER_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Maximum jobs of one kind pulled per cycle.
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  // Delivery attempts per webhook before the record is marked failed and never
  // retried again — see src/services/webhook.ts.
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  // Base for the exponential backoff between delivery attempts. A receiver that
  // is briefly down gets a fast retry; one that is genuinely broken is backed
  // away from rather than hammered.
  WEBHOOK_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1000),
  // How long a treasury proposal may sit unsigned before the worker marks it
  // expired (see src/worker/cleanupProposals.ts). A long-abandoned proposal is
  // already unsubmittable — its envelope's time bounds lapse and the treasury
  // account's sequence number moves on — so this is when Mergepay records the
  // state the chain has effectively already put it in.
  TREASURY_PROPOSAL_EXPIRY_DAYS: z.coerce.number().int().positive().max(365).default(7),

  // Retry budgets for settlement and anchor background jobs.
  WORKER_SETTLEMENT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_SETTLEMENT_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(1000),
  WORKER_SETTLEMENT_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(30_000),
  WORKER_SETTLEMENT_RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.25),
  WORKER_ANCHOR_MAX_ATTEMPTS: z.coerce.number().int().positive().default(5),
  WORKER_ANCHOR_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(5000),
  WORKER_ANCHOR_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(120_000),
  WORKER_ANCHOR_RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.25),

  // Per-call network timeouts (ms) — every outbound Horizon/anchor request
  // goes through src/services/timeout.ts's fetchWithTimeout/withTimeout, so
  // a slow or hung upstream can't block a worker cycle indefinitely.
  HORIZON_ACCOUNT_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  HORIZON_SUBMIT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  HORIZON_STATUS_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  HORIZON_FEE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_TOML_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_CHALLENGE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_TOKEN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_INTERACTIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  CONFIRM_POLL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  CONFIRM_POLL_DELAY_MS: z.coerce.number().int().positive().default(1500),
  NODE_ENV: z.string().default("development"),

  // Security-sensitive endpoint policies.
  RATE_LIMIT_STORE: z.enum(["memory", "database"]).default("memory"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().max(100000).default(100),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_HEALTH: z.coerce.number().int().positive().max(100000).default(60),
  RATE_LIMIT_ANCHOR_WEBHOOK_MAX: z.coerce.number().int().positive().max(100000).default(50),
  RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_ANCHOR_INIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_ANCHOR_INIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_ANCHOR_POLL_MAX: z.coerce.number().int().positive().max(100000).default(60),
  RATE_LIMIT_ANCHOR_POLL_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_TREASURY_SUBMIT_MAX: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_TREASURY_SUBMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  // Treasury proposal creation writes a proposal row and starts an approval
  // cycle, so it is bounded like the other state-changing treasury routes.
  RATE_LIMIT_TREASURY_PROPOSE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_TREASURY_PROPOSE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_AUTH_CHALLENGE_MAX: z.coerce.number().int().positive().max(100000).default(10),
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

const networkPassphrase =
  parsed.STELLAR_NETWORK === "public" ? Networks.PUBLIC : Networks.TESTNET;

export const config = {
  ...parsed,
  API_URL: parsed.API_PUBLIC_URL,
  SEP10_HOME_DOMAIN: parsed.SEP10_HOME_DOMAIN ?? apiHost,
  WEB_AUTH_DOMAIN: parsed.WEB_AUTH_DOMAIN ?? apiHost,
  isTest: process.env.NODE_ENV === "test" || process.env.VITEST === "true",
  networkPassphrase,
  jwtExpiresIn: `${parsed.ACCESS_TOKEN_TTL_SECONDS}s` as const,
};

export type Config = typeof config;