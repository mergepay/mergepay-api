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
  // Optional query timeout for Prisma client (ms). Default: 10 seconds.
  // Prevents hung queries from blocking Fastify request workers indefinitely.
  DATABASE_QUERY_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Postgres connection timeout (seconds) for the underlying driver. Bounds
  // how long Prisma waits when establishing a new socket to the database. A
  // slow/unreachable database fails fast instead of stalling a request worker.
  DATABASE_CONNECT_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
  // How long (seconds) a connection may wait for a free slot in Prisma's pool
  // before the request errors. Prevents a pool of exhausted connections from
  // blocking indefinitely under load.
  DATABASE_POOL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(10),
  // Maximum number of connections Prisma opens in its pool. Bounds total
  // database concurrency across Fastify workers on a single instance.
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().positive().default(5),
  PORT: z.coerce.number().int().positive().default(4000),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  API_PUBLIC_URL: urlSchema,
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  // CORS configuration. Comma-separated list of allowed origins.
  // Empty (default) means no cross-origin requests allowed — set explicitly for production.
  // Use "*" to allow all origins (development only).
  // Example: "https://app.example.com,https://staging.example.com"
  WEB_URL: z.string().default(""),
  // Allow credentials (cookies, auth headers) in CORS requests.
  // Defaults to false for security; enable only if your frontend requires it.
  CORS_ALLOW_CREDENTIALS: z.coerce.boolean().default(false),
  // Comma-separated list of allowed HTTP methods for CORS.
  // Defaults to standard REST methods.
  CORS_ALLOW_METHODS: z.string().default("GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS"),
  // Comma-separated list of allowed headers for CORS.
  // Defaults to common headers needed for API clients.
  CORS_ALLOW_HEADERS: z.string().default("Content-Type,Authorization,X-Requested-With,Idempotency-Key"),
  // Comma-separated list of headers exposed to the client.
  // Defaults to headers useful for debugging and pagination.
  CORS_EXPOSE_HEADERS: z.string().default("X-Request-ID,X-Correlation-ID,X-RateLimit-Limit,X-RateLimit-Remaining,X-RateLimit-Reset,Retry-After"),
  // Max age (seconds) for CORS preflight cache.
  // Defaults to 24 hours to reduce preflight requests.
  CORS_MAX_AGE: z.coerce.number().int().positive().default(86400),
  JWT_SECRET: z.string().min(16, "JWT_SECRET must be at least 16 characters"),
  // Bound a session to this deployment: a token minted for another environment
  // or audience is rejected even when the signing secret is shared.
  JWT_ISSUER: z.string().default("mergepay-api"),
  // Access-token lifetime. Short by design: a refresh token now covers the
  // gap, so a stolen access token stays useful for minutes rather than hours.
  // Expressed in seconds so it can be compared against the refresh TTL below.
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(86400).default(900),
  // Minimum remaining lifetime (seconds) a JWT must have when presented.
  // Tokens whose `exp` claim is closer than this margin to the current clock
  // are rejected as near-expired — even though the SDK's own check would
  // still accept them — so a token forged or replayed moments before expiry
  // never grants a session.
  TOKEN_EXPIRY_MARGIN_SECONDS: z.coerce.number().int().nonnegative().max(300).default(30),
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
  // Ordered, comma-separated Horizon endpoints. HORIZON_URL remains the
  // backwards-compatible primary endpoint when this is not set.
  HORIZON_URLS: z.string().optional(),
  
  // Fee configuration with sensible defaults
  FEE_CACHE_TTL: z.coerce.number().positive().default(30),
  EXCHANGE_RATE_CACHE_TTL: z.coerce.number().positive().default(300),
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
  // Per-anchor HMAC signing secrets for SEP-24 callbacks, as
  // "anchorName:secret,anchorName:secret". Deployments serving a single anchor
  // leave this empty and ANCHOR_WEBHOOK_SECRET is used for every callback.
  SEP24_WEBHOOK_SECRETS: z.string().default(""),
  // How far a SEP-24 callback's signing timestamp may be from the server clock
  // before the signature is treated as a replay. Only enforced for anchors that
  // send a timestamp header.
  SEP24_WEBHOOK_TOLERANCE_MS: z.coerce.number().int().positive().default(300000),

  // Stable asset configuration
  STABLE_ASSET_CODE: z.string().min(1, "STABLE_ASSET_CODE is required"),
  STABLE_ASSET_ISSUER: stellarPublicKeySchema,
  
  // File storage and request limits. See src/lib/request-limits.ts for how each
  // of these is enforced and what a client is told when one trips.
  UPLOADS_DIR: z.string().default("./uploads"),
  JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1024 * 1024),
  MULTIPART_MAX_FILES: z.coerce.number().int().positive().default(1),
  // Total multipart parts (fields + files) accepted in one request.
  MULTIPART_MAX_FIELDS: z.coerce.number().int().positive().default(20),
  // Largest single non-file form field. The upload route takes only a file, so
  // this is bounded tightly: a large *field* has no legitimate use here, and
  // busboy buffers field values in memory rather than streaming them.
  MULTIPART_FIELD_SIZE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(1024 * 1024)
    .default(64 * 1024),

  // Worker configuration
  WORKER_INTERVAL_MS: z.coerce.number().positive().default(30000),
  // How long a worker's claim on a job survives without renewal. A process that
  // crashes mid-job leaves its lease behind; another worker may take the job
  // over only once the lease has lapsed.
  WORKER_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Maximum jobs of one kind pulled per cycle.
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  // How long shutdown waits for the in-flight cycle to finish before it stops
  // waiting. Releasing a lease while its job is still submitting would let
  // another worker claim and resubmit the same payment, so shutdown drains
  // first. If the drain outruns this budget the leases are left to expire on
  // their own — a job recovered late is safe, a job submitted twice is not.
  WORKER_SHUTDOWN_DRAIN_MS: z.coerce.number().int().positive().default(30000),

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
  // Bounds for retrying *read-only* Horizon calls that failed with a transient
  // network or server error. Submission calls are never retried transparently;
  // these knobs apply only to safe read operations (see src/services/timeout.ts).
  HORIZON_READ_RETRY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  HORIZON_READ_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().min(0).default(250),
  HORIZON_READ_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  ANCHOR_TOML_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_CHALLENGE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_TOKEN_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_INTERACTIVE_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  ANCHOR_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  CONFIRM_POLL_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  CONFIRM_POLL_DELAY_MS: z.coerce.number().int().positive().default(1500),
  // How long a completed idempotency reservation replays before it is swept.
  // Past this window the key is free to be reused — a documented contract, not
  // an accident: an unbounded key space is a table that only grows.
  IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(24 * 60 * 60 * 1000),
  // How long an in-progress reservation blocks a retry with 409 before it is
  // treated as abandoned by a crashed process and may be re-claimed.
  IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Bounded retry policy for *safe* Horizon and anchor reads — see
  // src/services/retry.ts. Deliberately conservative: three attempts bound the
  // worst case at roughly three timeouts plus backoff, which is short enough
  // that a request still fails predictably during an upstream outage. Payment
  // submission and other state-changing calls are never retried here.
  UPSTREAM_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(3),
  UPSTREAM_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(200),
  UPSTREAM_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2000),
  // Fraction of each backoff delay that may be removed as jitter. Without it,
  // identical schedules across instances reconverge into synchronized bursts
  // against an upstream that is already struggling.
  UPSTREAM_RETRY_JITTER_RATIO: z.coerce.number().min(0).max(1).default(0.25),
  NODE_ENV: z.string().default("development"),
  RECONCILIATION_INTERVAL: z.coerce.number().int().positive().default(30000),
  CONFIRMATION_THRESHOLD: z.coerce.number().int().positive().default(1),
  TX_TIMEOUT: z.coerce.number().int().positive().default(300000),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

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
  RATE_LIMIT_SETTLEMENT_EXECUTE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_SETTLEMENT_EXECUTE_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  SEP24_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  SEP24_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GROUP: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_GROUP_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_HISTORY: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_HISTORY_WINDOW_MS: z.coerce.number().int().positive().default(60000),
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

export type Env = z.infer<typeof schema>;

let parsed: Env;
try {
  parsed = schema.parse(process.env);
} catch (error) {
  const message = safeErrorMessage(error);
  console.error(`\n❌ Configuration validation failed:\n  ${message}\n`);
  console.error("Please check your environment variables and try again.\n");
  process.exit(1);
}

export const env = parsed;

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
  ...env,
  HORIZON_ENDPOINTS: (env.HORIZON_URLS ?? env.HORIZON_URL)
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean),
  API_URL: env.API_PUBLIC_URL,
  SEP10_HOME_DOMAIN: env.SEP10_HOME_DOMAIN ?? apiHost,
  WEB_AUTH_DOMAIN: env.WEB_AUTH_DOMAIN ?? apiHost,
  isTest: env.NODE_ENV === "test" || process.env.VITEST === "true",
  networkPassphrase,
  jwtExpiresIn: `${env.ACCESS_TOKEN_TTL_SECONDS}s` as const,
};

export type Config = typeof config;
