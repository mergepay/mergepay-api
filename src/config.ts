import "dotenv/config";
import { z } from "zod";
import { Networks } from "@stellar/stellar-sdk";
import { rateLimitConfigSchema } from "./config/env";
import { sep10DomainSchema } from "./lib/sep10-domain";

// URL validation helper
const urlSchema = z.string().url("Invalid URL format");

/**
 * A Horizon endpoint. Beyond being a well-formed URL it must use HTTP(S):
 * Horizon is an HTTP API, so `ftp://horizon.example` passes `urlSchema` and
 * then fails at the first request, far from the misconfiguration. Rejecting
 * the scheme at boot makes the operator see it.
 */
const horizonUrlSchema = z
  .string()
  .url("Invalid URL format")
  .refine((value) => {
    // `urlSchema` has already rejected a non-URL, but every check in a Zod
    // schema runs and collects its issue, so this callback is still invoked
    // with the malformed input. It must answer "not HTTP(S)" rather than throw
    // a TypeError, or the failure surfaces as an unhandled exception instead
    // of a field-level validation message.
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Horizon endpoint must be a valid http:// or https:// URL");

// Stellar public key validation (G followed by 56 base32 characters)
const stellarPublicKeySchema = z.string().regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar public key format");

/**
 * Longest rate-limit window a deployment may configure: one hour.
 *
 * A window is the only thing standing between a typo and an endpoint that is
 * effectively unlimited — `RATE_LIMIT_AUTH_VERIFY_WINDOW_MS=60000000` parses as
 * a perfectly valid number and would hand an attacker sixteen days of
 * unlimited login attempts. Rejecting it at boot turns a silent security hole
 * into a startup error an operator cannot miss.
 */
const MAX_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

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
  // How long (ms) a request may occupy a connection before the server answers
  // it with 408 Request Timeout. Bounds stalled handlers — a slow-loris client,
  // a runaway Horizon call, or a database query the pool never resolves — so a
  // request cannot pin a worker thread indefinitely. See
  // src/plugins/request-timeout.ts for the enforcement mechanism.
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
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

  // Stellar configuration - required. The network name is case-insensitive on
  // input — operators write "TESTNET"/"PUBLIC" from the Stellar docs as often
  // as the lowercase form — and is normalized to lowercase so every consumer
  // (network passphrase selection, the Horizon/network consistency check
  // below) compares one spelling.
  STELLAR_NETWORK: z
    .enum(["testnet", "public", "TESTNET", "PUBLIC"], {
      errorMap: () => ({ message: "STELLAR_NETWORK must be either 'testnet' or 'public'" }),
    })
    .transform((value) => value.toLowerCase() as "testnet" | "public"),
  HORIZON_URL: horizonUrlSchema,
  // Ordered, comma-separated Horizon endpoints. HORIZON_URL remains the
  // backwards-compatible primary endpoint when this is not set. Each entry is
  // held to the same http(s) rule as HORIZON_URL, so a failover list cannot
  // smuggle in an endpoint the single-URL form would have rejected.
  HORIZON_URLS: z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (value === undefined) return;
      for (const entry of value.split(",").map((url) => url.trim()).filter(Boolean)) {
        const result = horizonUrlSchema.safeParse(entry);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `HORIZON_URLS contains an invalid endpoint "${entry}": ${
              result.error.issues[0]?.message ?? "invalid URL"
            }`,
          });
          return;
        }
      }
    }),
  
  // Fee configuration with sensible defaults
  FEE_CACHE_TTL: z.coerce.number().positive().default(30),
  EXCHANGE_RATE_CACHE_TTL: z.coerce.number().positive().default(300),
  MAX_FEE_STROOPS: z.coerce.number().int().positive().default(1000),
  DEFAULT_FEE_STROOPS: z.coerce.number().int().positive().default(100),
  
  // SEP-10 configuration - optional but validated if provided
  SEP10_SIGNING_SECRET: z.string().optional(),
  // If not set, derived from API_PUBLIC_URL so the deployed domain is used automatically.
  //
  // Validated with the same grammar the `/auth/verify` request schema uses
  // (src/lib/sep10-domain.ts), because the route compares a client's
  // `home_domain` against this value and names it in the error it returns. If
  // the two grammars differ, a client that obeys that error is rejected for the
  // shape of the domain the server just told it to send. An empty value is
  // refused rather than treated as unset: `env.SEP10_HOME_DOMAIN ?? apiHost`
  // passes `""` straight through, and a challenge whose home domain is the
  // empty string can never be verified.
  SEP10_HOME_DOMAIN: sep10DomainSchema.optional(),
  WEB_AUTH_DOMAIN: sep10DomainSchema.optional(),
  /**
   * How long a freshly issued SEP-10 challenge stays redeemable, in seconds.
   *
   * Bounded on both ends because this one number is a security parameter and an
   * ergonomic one at the same time. A long window widens the replay surface —
   * the durable store must hold every issued challenge until the envelope's own
   * `maxTime` plus skew has passed, and a challenge an attacker lifted is
   * signable the whole time — while a short one breaks the honest clients: a
   * hardware wallet or a slow mobile signer can take tens of seconds between
   * showing the envelope and returning it. SEP-10 itself recommends ~5 minutes,
   * so that is the default and the range only permits tightening or loosening
   * it by a bounded amount rather than an unbounded one.
   *
   * A typo like `3600` would otherwise be accepted as a valid number and
   * silently turn logins into hour-long credentials; rejecting it at boot makes
   * the mistake an operator sees.
   */
  SEP10_CHALLENGE_VALIDITY_SECONDS: z.coerce
    .number()
    .int("SEP10_CHALLENGE_VALIDITY_SECONDS must be a whole number of seconds")
    .min(30, "SEP10_CHALLENGE_VALIDITY_SECONDS must be at least 30 seconds")
    .max(600, "SEP10_CHALLENGE_VALIDITY_SECONDS must be at most 600 seconds")
    .default(300),
  
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

  // Startup database connection retry (src/lib/db-connect.ts). Exponential
  // backoff between attempts, capped at the max delay.
  DB_CONNECT_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  DB_CONNECT_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(500),
  DB_CONNECT_MAX_DELAY_MS: z.coerce.number().int().positive().default(10000),

  // Worker configuration
  WORKER_INTERVAL_MS: z.coerce.number().positive().default(30000),
  // How long a worker's claim on a job survives without renewal. A process that
  // crashes mid-job leaves its lease behind; another worker may take the job
  // over only once the lease has lapsed.
  WORKER_LEASE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  // Maximum jobs of one kind pulled per cycle.
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(500).default(50),
  // A submitted settlement with no Horizon record after this duration expires.
  WORKER_PENDING_SETTLEMENT_MAX_AGE_MS: z.coerce.number().int().positive().default(5 * 60 * 1000),
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

  // Retry budget for the worker *cycle tasks* themselves (issue #708): how
  // many times a sweep that throws — a transient database or Horizon error —
  // is retried in-cycle with exponential backoff before it is dead-lettered
  // for that cycle and logged as critical. The per-job budgets above govern
  // individual settlement/anchor rows; this one governs the batch sweeps.
  WORKER_CYCLE_TASK_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  WORKER_CYCLE_TASK_RETRY_INITIAL_DELAY_MS: z.coerce.number().int().positive().default(500),
  WORKER_CYCLE_TASK_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(10_000),
  // Consecutive failed cycles before the worker health heartbeat reports
  // `healthy: false` and emits a critical log line. A count rather than a
  // boolean because one failure is normal; a run of them is an outage.
  WORKER_HEALTH_UNHEALTHY_THRESHOLD: z.coerce.number().int().positive().default(3),

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
  // Whether Horizon *reads* (account load, transaction lookup) also retry an
  // HTTP 429 within the budget above, backing off exponentially and never
  // sooner than a Retry-After the upstream sends. Submissions are unaffected.
  // An explicit "true"/"false" string, because z.coerce.boolean() would turn
  // the string "false" into true.
  HORIZON_RETRY_ON_RATE_LIMIT: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
  NODE_ENV: z.string().default("development"),
  RECONCILIATION_INTERVAL: z.coerce.number().int().positive().default(30000),
  CONFIRMATION_THRESHOLD: z.coerce.number().int().positive().default(1),
  TX_TIMEOUT: z.coerce.number().int().positive().default(300000),
  MAX_RETRIES: z.coerce.number().int().nonnegative().default(3),

  // Generic rate-limit defaults (see issue #408). Declared in src/config/env.ts
  // so they can be unit-tested in isolation; merged into this schema so a
  // malformed value aborts startup through this module's fail-fast
  // process.exit(1) path instead of silently disabling the limiter.
  ...rateLimitConfigSchema.shape,
  // Security-sensitive endpoint policies.
  RATE_LIMIT_STORE: z.enum(["memory", "database"]).default("memory"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().max(100000).default(100),
  RATE_LIMIT_GLOBAL_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_HEALTH: z.coerce.number().int().positive().max(100000).default(60),
  RATE_LIMIT_ANCHOR_WEBHOOK_MAX: z.coerce.number().int().positive().max(100000).default(50),
  RATE_LIMIT_ANCHOR_WEBHOOK_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_ANCHOR_INIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_ANCHOR_INIT_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_ANCHOR_POLL_MAX: z.coerce.number().int().positive().max(100000).default(60),
  RATE_LIMIT_ANCHOR_POLL_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_TREASURY_SUBMIT_MAX: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_TREASURY_SUBMIT_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Treasury proposal creation writes a proposal row and starts an approval
  // cycle, so it is bounded like the other state-changing treasury routes.
  RATE_LIMIT_TREASURY_PROPOSE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_TREASURY_PROPOSE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_AUTH_CHALLENGE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_AUTH_VERIFY_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_AUTH_VERIFY_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_SETTLEMENT_CREATE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_SETTLEMENT_CREATE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_SETTLEMENT_CONFIRM_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_SETTLEMENT_CONFIRM_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_SETTLEMENT_EXECUTE_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_SETTLEMENT_EXECUTE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Expense creation writes an expense plus one share row per participant and
  // opens a settlement obligation, so it gets its own budget rather than
  // spending the caller's global allowance. It is looser than the settlement
  // policies because a legitimately active group creates expenses in bursts,
  // and it never shares a bucket with them.
  RATE_LIMIT_EXPENSE_CREATE_MAX: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_EXPENSE_CREATE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  SEP24_RATE_LIMIT_MAX: z.coerce.number().int().positive().max(100000).default(10),
  SEP24_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_GROUP: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_GROUP_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  RATE_LIMIT_HISTORY: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_HISTORY_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Issue #668 — the routes that were left on the global bucket. Each is a
  // category the table did not model: a public unauthenticated read, the
  // membership writes, outbound-webhook registration, and multipart upload.
  //
  // GET /api/exchange-rates answers without a session, and every call prices
  // two asset pairs through the anchor services, so it is the one route an
  // anonymous scanner can spend real upstream budget on. Keyed by IP, because
  // there is no identity to key by.
  RATE_LIMIT_EXCHANGE_RATES_MAX: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_EXCHANGE_RATES_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Invitations are writes with side effects beyond the caller's own data: each
  // one targets a third-party account. The budget is deliberately tighter than
  // group creation because a compromised admin session spams members, not
  // groups.
  RATE_LIMIT_GROUP_INVITE_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_GROUP_INVITE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Joining redeems an invite code, so the abuse shape is guessing codes that
  // belong to other groups. That threat is per-source, not per-account — an
  // attacker rotates accounts as easily as codes — so this bucket is keyed by
  // IP and runs on `onRequest`, before the session is even read.
  RATE_LIMIT_GROUP_JOIN_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_GROUP_JOIN_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Registering a webhook makes the server issue outbound HTTP to a
  // caller-supplied URL on a retry schedule, so a single account can multiply
  // one request into many egress attempts.
  RATE_LIMIT_WEBHOOK_CREATE_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_WEBHOOK_CREATE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Receipt uploads write to disk and are retried by clients that lost the
  // response, so they need a budget of their own rather than the global one
  // they share with every read the same client makes.
  RATE_LIMIT_UPLOAD_RECEIPT_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_UPLOAD_RECEIPT_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Issues #682 / #693 — the remaining sensitive routes that were still
  // answering from the global bucket. Each is budgeted for the work *it*
  // causes, not for the size of its response body.
  //
  // Logout revokes every refresh token a user holds, and the route answers
  // `{ ok: true }` whether or not the bearer token was valid — deliberately,
  // so it is not an oracle for token validity, but that also means an
  // anonymous caller can drive the write path. Keyed by IP, like the other
  // pre-session auth routes.
  RATE_LIMIT_AUTH_LOGOUT_MAX: z.coerce.number().int().positive().max(100000).default(20),
  RATE_LIMIT_AUTH_LOGOUT_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Editing or deleting an expense rewrites the obligations of every other
  // participant. `RATE_LIMIT_EXPENSE_CREATE_*` bounded only creation, so the
  // mutations that follow it drew on the global allowance instead.
  RATE_LIMIT_EXPENSE_MUTATE_MAX: z.coerce.number().int().positive().max(100000).default(30),
  RATE_LIMIT_EXPENSE_MUTATE_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Treasury signer configuration: enabling a treasury and validating a
  // proposed signer set both read live account state from Horizon, so each
  // call spends upstream budget, and both decide who may move group funds.
  // Tight, because neither is an operation a client repeats in bursts.
  RATE_LIMIT_TREASURY_CONFIG_MAX: z.coerce.number().int().positive().max(100000).default(10),
  RATE_LIMIT_TREASURY_CONFIG_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
  // Firing a test webhook turns one inbound request into an outbound HTTP
  // delivery to a caller-registered URL, on the same retry schedule as a real
  // event. `RATE_LIMIT_WEBHOOK_CREATE_*` bounded registering an endpoint but
  // not ringing it, which is the cheaper half of the same amplification.
  RATE_LIMIT_WEBHOOK_TEST_MAX: z.coerce.number().int().positive().max(100000).default(5),
  RATE_LIMIT_WEBHOOK_TEST_WINDOW_MS: z.coerce.number().int().positive().max(MAX_RATE_LIMIT_WINDOW_MS).default(60000),
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
).refine(
  (data) => {
    // `signToken` sets `exp` exactly ACCESS_TOKEN_TTL_SECONDS after issuance and
    // `verifyToken` rejects any token with less than TOKEN_EXPIRY_MARGIN_SECONDS
    // left (src/services/jwt.ts). A margin at or above the TTL therefore makes
    // `exp - now < margin` true for every token the instant it is minted: the
    // API boots, signs, and then 401s every authenticated request with
    // TOKEN_EXPIRED, with nothing else in the system pointing at the cause.
    // `ACCESS_TOKEN_TTL_SECONDS=25` against the default 30s margin is enough to
    // reach it, so the pair is validated rather than each half alone.
    return data.ACCESS_TOKEN_TTL_SECONDS > data.TOKEN_EXPIRY_MARGIN_SECONDS;
  },
  {
    message:
      "ACCESS_TOKEN_TTL_SECONDS must be greater than TOKEN_EXPIRY_MARGIN_SECONDS, otherwise every access token is rejected as expired the moment it is issued",
    path: ["ACCESS_TOKEN_TTL_SECONDS"],
  }
);

export function safeErrorMessage(error: unknown): string {
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

export const envSchema = schema;

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
