<div align="center"> 

# Mergepay — API

**The Stellar-native settlement engine behind Mergepay.**

Authentication, group & expense logic, the settlement engine, Stellar
integration, treasury multisig, anchor (SEP-24) flows, and background jobs.

[Live app](https://mergepay.vercel.app) ·
[Web repo](https://github.com/mergepay/mergepay-web) ·
[API repo](https://github.com/mergepay/mergepay-api)

[![CI](https://github.com/mergepay/mergepay-api/actions/workflows/ci.yml/badge.svg)](https://github.com/mergepay/mergepay-api/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict%20mode-3178C6?logo=typescript&logoColor=white)](https://github.com/mergepay/mergepay-api/blob/main/tsconfig.json)
![License](https://img.shields.io/github/license/mergepay/mergepay-api)
![Stellar](https://img.shields.io/badge/stellar-testnet-blueviolet)

</div>

## Maintainers

| Maintainer | Role | GitHub |
|---|---|---|
| Fuhad (K1NGD4VID) | Maintainer | [@K1NGD4VID](https://github.com/K1NGD4VID) |

Questions and contributions are welcome — open an issue or PR, or start a
[discussion](https://github.com/mergepay/mergepay-api/discussions).

---

Mergepay is a Stellar-native group settlement app that turns shared spending into
transparent, auditable, low-fee on-chain payments for friends, roommates, and
small communities. This is the **backend**; the frontend lives in
[`mergepay-web`](https://github.com/mergepay/mergepay-web).

> **Built on Stellar.** Every settlement is a real on-chain Stellar payment: login is
> SEP-10 wallet auth, payments carry a `MP:<code>` memo linking them to an expense,
> balances settle in XLM or USDC over trustlines, shared treasuries use Stellar
> multisig, and fiat on/off-ramp goes through SEP-24 anchors. The server never holds
> user keys — it builds unsigned XDRs that the user's wallet signs.
>
> **🌊 Open to contributors via Drips Wave (Stellar ecosystem).** Scoped, bounty-ready
> issues live in [DRIPS_WAVE.md](DRIPS_WAVE.md); see [CONTRIBUTING.md](CONTRIBUTING.md)
> to get started.

## Why Stellar

- **SEP-10** — wallet-based auth; the user's public key is their identity.
- **Payments + memos** — every settlement is an on-chain payment carrying a
  `MP:<code>` memo that links it to a specific expense.
- **Trustlines** — settle in native XLM or a stable asset (USDC by default).
- **Multisig** — shared treasuries can require multiple signers for withdrawals.
- **SEP-24** — anchor deposit/withdraw bridges fiat and Stellar.

**Private keys never touch the server.** The API builds *unsigned* transaction
envelopes; the user's wallet signs them; the API validates the signed XDR against
the original intent and submits it to Horizon. The only key the server holds is
its own SEP-10 signing key.

## Architecture

```
                ┌──────────────┐
   wallet ────▶ │  mergepay-web│  (Next.js)
                └──────┬───────┘
                       │ REST + Bearer JWT
                ┌──────▼───────┐      ┌──────────────┐
                │  mergepay-api│◀────▶│  PostgreSQL  │
                │   (Fastify)  │      └──────────────┘
                └──┬────────┬──┘
       build/submit│        │ poll status
                ┌──▼──┐  ┌──▼─────────┐
                │Horizon│ │  worker    │ (settlement + anchor reconciliation)
                └──────┘  └────────────┘
                   ▲
                   │ SEP-10 / SEP-24
              ┌────┴─────┐
              │  Anchor  │
              └──────────┘
```

## Prerequisites

- Node.js 20+
- PostgreSQL 14+
- A Stellar SEP-10 signing keypair (generate one below)

## Setup

For the quickest local dev path against Stellar testnet, see [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md).

```bash
git clone https://github.com/mergepay/mergepay-api.git
cd mergepay-api
npm install
cp .env.example .env

# Generate a server SEP-10 signing key and paste the secret into .env
npm run gen:sep10key

# Create the database schema
npm run prisma:generate
npm run prisma:migrate        # creates tables (needs DATABASE_URL)

# (optional) demo data
npm run db:seed

# Run it
npm run dev                   # API on :4000
npm run worker                # background reconciliation worker (separate shell)
```

### Local database setup

For local development, use PostgreSQL 14+ and Node.js 20+. Start PostgreSQL,
then create the `mergepay` database once:

```bash
createdb mergepay
```

Copy `.env.example` to `.env` if you have not already, and set `DATABASE_URL`
to a connection string for that database, for example:

```env
DATABASE_URL=postgresql://postgres:your-password@localhost:5432/mergepay
```

Generate the Prisma client and apply the migrations to initialize the schema:

```bash
npm run prisma:generate
npm run prisma:migrate
```

To add the local development seed data, run:

```bash
npm run db:seed
```

### Seed data

`npm run db:seed` runs [prisma/seed.ts](prisma/seed.ts) and populates a
disposable demo dataset so API endpoints can be exercised immediately, without
manual bootstrapping. The script is **idempotent**: every row is written with
an upsert keyed by a deterministic id (or another natural unique key), so
running it again never throws a unique constraint violation and never
duplicates data. A re-run also restores any seed-owned row to its canonical
demo values. Rows left behind by older versions of the seed (random ids) are
untouched — delete them by hand if you want a clean slate.

| Row | Details |
| --- | --- |
| Users | `Ada`, `Kola`, `Zo`, `Tunde` — deterministic testnet keypairs |
| Groups | `Lagos Trip` (4 members) and `Flat 12B` (3 members, treasury enabled) |
| Expenses | `Dinner` (equal), `Airport transfer` (equal), `Groceries` (custom split), `Wi-Fi subscription` (equal) |
| Settlements | `SEEDSETTLE` confirmed, `SEEDQUEUE2` pending signature, `SEEDRETRY2` failed and retryable — each with status history |
| Treasury | confirmed deposit `SEEDTREASR` (100 XLM) and pending deposit `SEEDGRANT2` (50 XLM) in `Flat 12B` |
| Invite | code `SEEDCLUB` for `Lagos Trip` (max 10 uses) |

The demo accounts are derived from public labels (`mergepay:demo:…`), so their
secret keys are recomputable by anyone: use them only in local or testnet
databases and never fund them with anything of value. To sign demo
transactions (for example in Stellar Laboratory), print the secret seeds with:

```bash
SEED_PRINT_SECRETS=1 npm run db:seed
```

Seeded intents carry `expiresAt = null`, which the API reads as "no recorded
deadline", so demo rows stay actionable instead of expiring while the database
sits idle.

New to the codebase? The typing standards enforced across `src/` are documented in [TypeScript strict mode](#typescript-strict-mode).

## Environment variables

See [.env.example](.env.example). Key ones:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing session JWTs (default 15min expiry, configurable via `ACCESS_TOKEN_TTL_SECONDS`) |
| `JWT_ISSUER` | JWT issuer claim (default: `mergepay-api`) |
| `JWT_AUDIENCE` | JWT audience claim (default: `mergepay-app`) |
| `ACCESS_TOKEN_TTL_SECONDS` | Access token lifetime in seconds (default: 900 / 15 minutes) |
| `REFRESH_TOKEN_TTL_MS` | Refresh token lifetime in milliseconds (default: 30 days) |
| `STELLAR_NETWORK` | `testnet` or `public` |
| `HORIZON_URL` | Horizon server |
| `SEP10_SIGNING_SECRET` | Server's SEP-10 signing key (`npm run gen:sep10key`) |
| `WEB_URL` | Frontend origin allow-list for CORS + invite links (comma-separated; `*` for local dev) |
| `ANCHOR_HOME_DOMAIN` | SEP-24 anchor home domain (default SDF test anchor) |
| `ANCHOR_WEBHOOK_SECRET` | Shared secret for the anchor webhook |
| `STABLE_ASSET_CODE` / `STABLE_ASSET_ISSUER` | Stable asset for settlement |

#### Database connection & query timeouts

Prisma is initialized in [src/db.ts](src/db.ts) with explicit connection
resilience settings so a slow, saturated, or partitioned PostgreSQL **fails
fast instead of hanging request workers indefinitely**. The values below are
appended to `DATABASE_URL` as query parameters (`buildDatasourceUrl`) and
forwarded to the underlying driver; a per-query middleware adds a wall-clock
budget on top.

| Variable | Default | Description |
| --- | --- | --- |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | 10 | Max time to establish a socket to Postgres |
| `DATABASE_POOL_TIMEOUT_SECONDS` | 10 | Max wait for a free pooled connection before erroring |
| `DATABASE_CONNECTION_LIMIT` | 5 | Max pooled connections per instance |
| `DATABASE_QUERY_TIMEOUT_MS` | 10000 | Per-query wall-clock budget enforced by middleware |

Parameters already present in `DATABASE_URL` are overridden by these values,
so the effective timeout policy is always the one configured here. When a
query exceeds `DATABASE_QUERY_TIMEOUT_MS` it rejects with `Query timeout after
Nms`, the request fails promptly, and the health check
(`checkDatabaseConnection`, used by `/health/ready`) applies the same budget.

#### CORS configuration

Cross-origin access for the frontend (`mergepay-web`) is configured entirely
from the environment: `src/app.ts` registers `@fastify/cors` with the options
built by `src/lib/cors.ts`. Preflights are answered `204` inside the plugin's
`onRequest` hook — ahead of authentication and rate limiting — because a
browser never sends an `Authorization` header on an `OPTIONS` probe.

| Variable | Default | Description |
| --- | --- | --- |
| `WEB_URL` | `""` (deny cross-origin) | Origin allow-list, comma-separated; `*` reflects any origin and is for local development only (the shipped `.env.example` sets `*`) |
| `CORS_ALLOW_CREDENTIALS` | `false` | Whether cross-origin requests may carry credentials; never enable alongside `WEB_URL=*` outside local development |
| `CORS_ALLOW_METHODS` | `GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS` | Methods advertised on a preflight — restricted to this list, never echoed from the request |
| `CORS_ALLOW_HEADERS` | `Content-Type,Authorization,X-Requested-With,Idempotency-Key` | Request headers a cross-origin request may send |
| `CORS_EXPOSE_HEADERS` | `X-Request-ID,X-Correlation-ID,X-RateLimit-*`,`Retry-After` | Response headers made readable to the caller |
| `CORS_MAX_AGE` | `86400` | Preflight cache lifetime in seconds |

An empty `WEB_URL` denies every cross-origin request while leaving same-origin
and non-browser clients (no `Origin` header) to the routes' own
authentication. If `WEB_URL` names a `*.vercel.app` host, preview deployments
of the frontend (`mergepay-web-*.vercel.app`) are allowed too.

#### Horizon read retries

Read-only Horizon calls (currently fee statistics) retry transient failures —
timeouts, connection resets, and selected 5xx responses — with bounded,
configurable backoff so a temporary upstream blip does not immediately fail a
recoverable read. Transaction submission is **never** transparently retried by
this helper.

| Variable | Default | Description |
| --- | --- | --- |
| `HORIZON_READ_RETRY_MAX_ATTEMPTS` | 3 | Total attempts (including the first) for a transiently failing read |
| `HORIZON_READ_RETRY_INITIAL_DELAY_MS` | 250 | Backoff before the first retry |
| `HORIZON_READ_RETRY_MAX_DELAY_MS` | 2000 | Cap on the exponential backoff |

#### Upstream retry configuration

General retry configuration for safe Horizon and anchor reads (see `src/services/retry.ts`):

| Variable | Default | Description |
| --- | --- | --- |
| `UPSTREAM_RETRY_MAX_ATTEMPTS` | 3 | Total retry attempts for safe upstream calls |
| `UPSTREAM_RETRY_INITIAL_DELAY_MS` | 200 | Initial delay before first retry |
| `UPSTREAM_RETRY_MAX_DELAY_MS` | 2000 | Maximum delay cap for exponential backoff |
| `UPSTREAM_RETRY_JITTER_RATIO` | 0.25 | Fraction of delay applied as random jitter |
| `HORIZON_RETRY_ON_RATE_LIMIT` | true | Horizon reads in `src/services/stellar.ts` also retry HTTP 429 (honouring `Retry-After` up to `UPSTREAM_RETRY_MAX_DELAY_MS`). Submissions are never retried. |

#### Idempotency configuration

Idempotency for `POST /api/settlements/execute` prevents duplicate submissions:

| Variable | Default | Description |
| --- | --- | --- |
| `IDEMPOTENCY_TTL_MS` | 86400000 (24h) | How long a completed reservation replays its stored status |
| `IDEMPOTENCY_IN_PROGRESS_TIMEOUT_MS` | 60000 (1m) | Timeout for in-progress reservations before they can be reclaimed |

#### SEP-24 webhook configuration

Configuration for SEP-24 anchor callbacks (`POST /api/webhooks/sep24`):

| Variable | Default | Description |
| --- | --- | --- |
| `SEP24_WEBHOOK_SECRETS` | "" | Per-anchor HMAC secrets as "anchorName:secret,anchorName:secret" |
| `SEP24_WEBHOOK_TOLERANCE_MS` | 300000 (5m) | Maximum timestamp deviation allowed for anchor callbacks |

### Rate limiting

Every route is covered by a global default limit
(`RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MS`, default 100 per
minute). `/health` and `/docs` are exempt from it so probes and the API
reference stay reachable during an incident. Endpoints with a different
traffic pattern or trust boundary replace that default with their own bucket:

| Route(s) | Variables | Default |
| --- | --- | --- |
| `POST /auth/challenge` | `RATE_LIMIT_AUTH_CHALLENGE_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /auth/verify`, `POST /auth/refresh` | `RATE_LIMIT_AUTH_VERIFY_MAX` / `_WINDOW_MS` | 10 / 1 min |
| `POST /groups/:id/expenses` | `RATE_LIMIT_EXPENSE_CREATE_MAX` / `_WINDOW_MS` | 30 / 1 min |
| `POST /expenses/:id/settle`, `POST /groups/:id/settlements`, `POST /groups/:id/treasury/deposit`, `POST /groups/:id/treasury/withdraw` | `RATE_LIMIT_SETTLEMENT_CREATE_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /settlements/:id/confirm`, `POST /withdraw/:id/confirm` | `RATE_LIMIT_SETTLEMENT_CONFIRM_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /api/settlements/execute` | `RATE_LIMIT_SETTLEMENT_EXECUTE_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /treasury-transactions/:id/confirm`, `POST /groups/:groupId/treasury/proposals/:proposalId/sign`, `POST /api/treasury/proposals/:id/signatures` | `RATE_LIMIT_TREASURY_SUBMIT_MAX` / `_WINDOW_MS` | 30 / 1 min |
| `POST /groups/:groupId/treasury/proposals`, `POST /api/treasury/proposals` | `RATE_LIMIT_TREASURY_PROPOSE_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /anchors/deposit`, `POST /anchors/withdraw`, `POST /anchors/sessions/:id/complete`, `POST /api/sep24/deposit`, `POST /api/sep24/withdraw`, `POST /withdraw` | `RATE_LIMIT_ANCHOR_INIT_MAX` / `_WINDOW_MS` | 10 / 1 min |
| `GET /anchors`, `GET /anchors/sessions`, `GET /anchors/sessions/:id` | `RATE_LIMIT_ANCHOR_POLL_MAX` / `_WINDOW_MS` | 60 / 1 min |
| `POST /anchors/webhook` | `RATE_LIMIT_ANCHOR_WEBHOOK_MAX` / `_WINDOW_MS` | 50 / 1 min |
| `POST /api/sep24/callback`, `POST /api/webhooks/sep24` | `SEP24_RATE_LIMIT_MAX` / `_WINDOW_MS` | 10 / 1 min |
| `POST /groups` | `RATE_LIMIT_GROUP` / `_WINDOW_MS` | 10 / 1 min |
| `GET /history` | `RATE_LIMIT_HISTORY` / `_WINDOW_MS` | 30 / 1 min |

**Tuning a deployment.** Every value above is an environment variable with a
safe default, so a deployment overrides only what it needs — for example a
wallet integration that legitimately retries submissions can raise
`RATE_LIMIT_SETTLEMENT_CONFIRM_MAX` without loosening SEP-10 or anchor
budgets. Windows are milliseconds and are rejected at startup above one hour;
maximums must be positive integers. Both bounds exist so a typo cannot silently
disable limiting. The single source of truth for which route gets which policy
is the table in [src/lib/rate-limit.ts](src/lib/rate-limit.ts); routes name a
policy rather than repeating numbers, and each policy has its own key prefix,
which is what makes the buckets independent. The registration of the limiter
itself — global limits, key strategy, counter store, and the 429 body — is in
[src/plugins/rate-limit.ts](src/plugins/rate-limit.ts).

Every route above has a bucket separate from ordinary authenticated reads, so
exhausting a submission or anchor budget never blocks a client from reading its
own groups, expenses, or settlement status.

Limit keys are the authenticated user's SEP-10 public key when the request
carries a session, and the resolved client IP otherwise. SEP-10 has no session
yet, so `/auth/challenge`, `/auth/verify`, and `/auth/refresh` are keyed by IP
alone: a public-key bucket there would make the 429 threshold depend on whether
an account is known to the API, turning the limiter into an account oracle.
`req.ip` does not trust `X-Forwarded-For` unless Fastify's `trustProxy` option
is explicitly enabled, which this app does not do by default. If you deploy
behind a reverse proxy or load balancer and want per-client (rather than
per-proxy) limiting, enable `trustProxy` in `src/app.ts` and make sure only your
proxy can reach the app directly.

The anchor webhook's rate limit is abuse protection only — it never
replaces the shared-secret (`ANCHOR_WEBHOOK_SECRET`) check, which remains
the actual authentication gate for that route.

By default (`RATE_LIMIT_STORE=memory`) counters live in each API process's
memory, which is fine for a single instance. Set `RATE_LIMIT_STORE=database`
to share counters across multiple instances via a small Postgres-backed
store (`rate_limit_buckets` table, see
`src/services/rate-limit-store.ts`). That store fails **open**: if a count
query errors (e.g. a transient database outage), the request is allowed
through rather than the whole API returning 500s — a degraded rate limiter
is preferable to a full outage. Every 429 response includes standard
`Retry-After` / `X-RateLimit-*` headers and the standard error envelope
(`{"error": ..., "code": "RATE_LIMITED", "message": ..., "requestId": ...}`).

### Request size limits

The API enforces explicit limits on JSON bodies and multipart uploads to prevent
memory exhaustion and DoS attacks:

| Type | Variable | Default | Description |
| --- | --- | --- | --- |
| JSON body | `JSON_BODY_LIMIT_BYTES` | 256 KB | All JSON request bodies (auth, settlements, anchors) |
| Multipart file | `MULTIPART_FILE_SIZE_BYTES` | 5 MB | Max file size in multipart uploads (e.g. receipts) |
| Multipart files | `MULTIPART_MAX_FILES` | 1 | Maximum number of files per multipart request |
| Multipart fields | `MULTIPART_MAX_FIELDS` | 10 | Maximum number of form fields per multipart request |

Oversized requests are rejected with a `413 Payload Too Large` or `400 Bad Request`
response before expensive business logic or external Stellar calls run. Request
bodies are fully validated with Zod before use; the size limits ensure the
validator runs efficiently.

### Worker job tracking and recovery

The background worker drives settlement submission and SEP-24 anchor polling
with the same claim-based rules (see `src/worker/index.ts`):

- **Claim before work.** A job is claimed with a conditional update that writes
  a lease (`claimedBy`, `leaseExpiresAt`). Two workers can never drive the same
  transition. A crashed process leaves its lease behind; at the top of every
  cycle `recoverStaleSettlements()`/`recoverStaleAnchorSessions()` free
  expired leases (default lease timeout: `WORKER_LEASE_TIMEOUT_MS`, 60s), so a
  restart resumes work without duplicating it.
- **Classify before retrying.** Every failure is categorised by
  `src/services/job-retry.ts` into `transient` (rate limits, outages — safe to
  retry), `indeterminate` (timeout, dropped socket — the worker checks Horizon
  by the envelope's deterministic hash *before* resubmitting, so an already
  applied transaction is never submitted twice), and `permanent` (rejected
  transaction, expired intent, authorization — no retry, the job fails).
- **Persist the job state.** Attempts, the next eligible time, the failure
  category, and the final reason are columns on the row (`retryCount`,
  `nextAttemptAt`, `errorCategory`, `failureReason`), never process memory.
  An exhausted job stops retrying and is marked `failed` with a sanitized
  reason; retries and failures are also recorded in the audit log / status
  history.

Retry budgets are exponential with jitter and fully configurable via env vars
(see `.env.example`):

- `WORKER_SETTLEMENT_MAX_ATTEMPTS` (default 3), `WORKER_SETTLEMENT_RETRY_INITIAL_DELAY_MS`
  (default 1000), `WORKER_SETTLEMENT_RETRY_MAX_DELAY_MS` (default 30000),
  `WORKER_SETTLEMENT_RETRY_JITTER_RATIO` (default 0.25)
- `WORKER_ANCHOR_MAX_ATTEMPTS` (default 5), `WORKER_ANCHOR_RETRY_INITIAL_DELAY_MS`
  (default 5000), `WORKER_ANCHOR_RETRY_MAX_DELAY_MS` (default 120000),
  `WORKER_ANCHOR_RETRY_JITTER_RATIO` (default 0.25)
- `WORKER_CYCLE_TASK_MAX_ATTEMPTS` (default 3), `WORKER_CYCLE_TASK_RETRY_INITIAL_DELAY_MS`
  (default 500), `WORKER_CYCLE_TASK_RETRY_MAX_DELAY_MS` (default 10000) — retries
  for the *cycle tasks* themselves (issue #708). A sweep that throws a transient
  database or Horizon error is retried in-cycle with exponential backoff;
  permanent and indeterminate failures are left to the next cycle. A task whose
  budget is exhausted is dead-lettered as a critical log line for that cycle
  while its sibling tasks continue.
- `WORKER_HEALTH_UNHEALTHY_THRESHOLD` (default 3) — consecutive failed cycles
  before the per-cycle `worker_health` heartbeat reports `healthy: false` and a
  critical health line is emitted.

## How it works

### SEP-10 login
`POST /auth/challenge` builds a challenge transaction signed by the server key.
The wallet signs it; `POST /auth/verify` validates the signature (handling
unfunded accounts via the master key), upserts the user, and returns a JWT.

Challenge transactions carry a **strictly validated validity window**: the
envelope's own `minTime`/`maxTime` are checked against server time with a
bounded 30-second clock-skew tolerance. A challenge whose `maxTime` has elapsed
is rejected with 401 `CHALLENGE_EXPIRED` (the remedy is to request and sign a
fresh one); one whose `minTime` has not been reached returns
`CHALLENGE_NOT_YET_VALID`, and a window longer than the 300s validity the
server issues returns `CHALLENGE_WINDOW_TOO_LONG`. All other verification
failures stay the generic 401 `UNAUTHORIZED`, so rejections cannot be probed
for which structural check failed. Challenges are single-use (durable replay
detection), and the worker's challenge cleanup purges replay records once
their window closes, keeping them for 24h forensics before deletion.

### Settlement
1. `POST /expenses/:id/settle` (or `POST /groups/:id/settlements`) builds an
   **unsigned** payment XDR — correct source, destination, asset, amount, and a
   `MP:<shortCode>` memo — and records a `pending` settlement.
2. The wallet signs the XDR.
3. `POST /settlements/:id/confirm` re-parses the signed XDR, **validates it
   matches the stored intent exactly** (source, single payment op, destination,
   asset, amount, memo, time bounds) and rejects mismatches with `xdr_mismatch`,
   then submits to Horizon, stores the tx hash, and marks the expense share
   `settled`.
4. `GET /settlements/:id/status` is the single source of truth from then on. It
   combines persisted state with a bounded Horizon lookup and reports one of
   `awaiting_signature`, `submitted`, `confirmed`, `failed`, or `expired`. A
   transaction Horizon has not indexed yet is reported as `submitted` with
   `onChain.found: false` — never as a confirmed payment. See
   [docs/api-contract.md](docs/api-contract.md#get-settlementsidstatus).

### Transaction intent expiration

Every unsigned XDR the API builds carries a **server-controlled** deadline,
recorded on the row as `expiresAt` and set as the transaction's own `maxTime` so
the stored intent and the on-chain envelope describe the same moment. Creation
responses include `expiresAt` and `expiresInSeconds`.

- The deadline comes from the server clock. A client may request a *shorter*
  window via `validitySeconds` (30–300s); it can never extend one, and it never
  supplies an absolute timestamp. An out-of-range request is a
  `VALIDATION_ERROR`.
- Signing and submission re-check the deadline. `POST /settlements/:id/confirm`
  and `POST /treasury-transactions/:id/confirm` reject a stale intent with
  `INTENT_EXPIRED` (400) — deliberately distinct from `XDR_MISMATCH` (the
  envelope is wrong) and `UNAUTHORIZED`/`FORBIDDEN` (the caller is wrong), so a
  client knows to request a fresh transaction rather than to debug.
- Submission also validates the signed envelope's own time bounds against the
  stored intent: an unbounded envelope, or one valid longer than the intent it
  was built for, is an `XDR_MISMATCH`. No expired transaction is ever sent to
  Horizon or an anchor — the worker marks such a settlement `expired` and
  releases its expense share instead of retrying.
- Comparisons allow a bounded **30-second** clock-skew tolerance
  (`CLOCK_SKEW_TOLERANCE_SECONDS` in
  [src/lib/time-bounds.ts](src/lib/time-bounds.ts)), so a wallet whose clock is a
  few seconds off still works while a genuinely stale envelope is still
  rejected. It is a constant rather than a config knob because widening it
  weakens replay protection proportionally.

### Treasury (multisig)
A group registers a Stellar account it created in a wallet (the API never holds
the key). Deposits are signed by the depositor; withdrawals are signed from the
treasury account and, when `treasuryRequiredSigners > 1`, returned in
`awaiting_signatures` for additional signers before submission.

### Anchors (SEP-24)
`POST /anchors/deposit|withdraw` creates a session and fetches a SEP-10 challenge
**from the anchor**. The wallet signs it; `POST /anchors/sessions/:id/complete`
exchanges it for an anchor JWT and the interactive deposit/withdraw URL. A signed
`POST /anchors/webhook` updates session status; the worker also polls.

`/api/sep24/deposit|withdraw` are aliases of the same two routes and share the
same request contract. Both are validated by the Zod schemas in
[src/validations/sep24.ts](src/validations/sep24.ts) before the anchor is
contacted, so a malformed request never reaches an upstream call, the database,
or the audit log:

- The body is `.strict()`: `assetCode` (1–12 alphanumeric characters,
  upper-cased), an optional `assetIssuer`, `account`/`to`/`refundAddress` as
  checksum-valid Stellar public keys, an optional `amount` (required to
  withdraw) that must be a positive decimal string with at most 7 places, and
  `memo`/`refundMemo` bounded by their `memoType` (`text` ≤ 28 UTF-8 bytes with
  no control characters, `id` an unsigned 64-bit integer, `hash` a
  base64-encoded 32-byte value). `memo` and `memoType` must be supplied
  together, unknown keys are rejected, and `extraMetadata` is capped at 20 keys
  and 2 KB serialized.
- The query string is validated too, and carries nothing but an optional `lang`.
  A parameter the body does not define — `?asset_code=XLM`, the SEP-24 wire
  spelling of the body's `assetCode` — is a 400 naming that parameter, not a
  silently dropped hint that the body then contradicts.
- The asset is checked against the configured registry *as a pair*: an issuer
  Mergepay does not issue that asset under is rejected instead of being dropped
  in favour of the configured one.
- Every rejection is the shared `VALIDATION_ERROR` envelope with per-field
  `details` and `issues`. The routes document the same schemas through
  `openApiBody(..., { enforce: false })`, so Fastify's ajv cannot pre-empt the
  handler and answer in its own words — the Zod schema is the only validator.

Status tracking (`src/services/anchor.ts`, `src/services/anchor-status.ts`):

- `anchorService.getTransaction` reads `GET /transaction` and validates it with
  the Zod schema in `src/services/anchor-schemas.ts`. `id`, `kind` and `status`
  are required, unknown fields are stripped, and amounts stay decimal strings
  (a malformed optional field is dropped and logged, never coerced). Failures
  raise typed errors from `src/services/anchor-errors.ts`, all 502 over HTTP.
  Each attempt is bounded by `ANCHOR_POLL_TIMEOUT_MS`, and transient failures
  are retried per `UPSTREAM_RETRY_*`.
- Every status change goes through `applyAnchorSessionTransition`: a
  conditional update on the current status plus a `status_history` row and an
  audit row, all in one transaction. Re-delivering the same status is a no-op,
  terminal states (`completed`, `refunded`, `expired`, `no_market`,
  `too_small`, `too_large`; `error` may still become `refunded`) are never
  walked back, and concurrent writers record the transition exactly once.
- A status outside the SEP-24 set is logged and ignored. The session keeps its
  last known state and the worker keeps polling.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/auth/challenge` · `/auth/verify` · `/auth/logout` | SEP-10 auth |
| GET/PATCH | `/me` | Current user |
| POST/GET | `/groups` · `/groups/:id` | Groups |
| POST | `/groups/:id/invite` · `/groups/join` · `/groups/:id/leave` · `/groups/:id/archive` | Membership |
| POST/GET/PATCH/DELETE | `/groups/:id/expenses` · `/expenses/:id` | Expenses |
| POST | `/expenses/:id/settle` · `/groups/:id/settlements` · `/settlements/:id/confirm` | Settlement |
| GET | `/settlements/:id/status` | Settlement state (see [docs/api-contract.md](docs/api-contract.md#get-settlementsidstatus)) |
| GET | `/groups/:id/balances` · `/groups/:id/ledger` | Balances & ledger |
| POST/GET | `/groups/:id/treasury/*` · `/treasury-transactions/:id/confirm` | Treasury |
| GET/POST | `/anchors` · `/anchors/deposit` · `/anchors/withdraw` · `/anchors/sessions/:id/complete` · `/anchors/sessions` · `/anchors/webhook` | Anchors |
| GET | `/history` | Cross-group history |
| POST/GET | `/uploads/receipt` · `/uploads/:file` | Receipts |
| GET | `/health` · `/health/live` · `/health/ready` | Liveness & readiness probes (see [HEALTH.md](HEALTH.md)) |

All request bodies are validated with Zod; every group action checks membership
(and admin rights where required). The full contract — error envelope and codes,
pagination, intent expiration, and the settlement status endpoint — is documented
in [docs/api-contract.md](docs/api-contract.md) and mirrored in
`mergepay-web/src/lib/types.ts`.

### Pagination

Every list endpoint uses one cursor convention, defined and documented in
[src/lib/pagination.ts](src/lib/pagination.ts) and mirrored in
[docs/api-contract.md](docs/api-contract.md).

| Parameter | Type | Default | Notes |
| --- | --- | --- | --- |
| `limit` | integer 1–100 | 50 | Outside the range → `VALIDATION_ERROR`, never a silent clamp |
| `cursor` | opaque string | — | From a previous response's `meta.nextCursor`; malformed → `INVALID_CURSOR` |
| `order` | `desc` \| `asc` | `desc` | Applies to the `(createdAt, id)` ordering |

Every list response carries the same metadata:

```json
{ "meta": { "nextCursor": "MTc2…", "hasMore": true, "limit": 50, "order": "desc" } }
```

Ordering is always the pair `(createdAt, id)`, so rows sharing a timestamp have
a defined order and can never appear on two pages or be skipped between them.
Queries fetch `limit + 1` rows — the page plus one lookahead row to compute
`hasMore` — so no endpoint ever loads a full result set. Cursors carry only
ordering coordinates, never a group or user id: access is decided by each
query's own scope plus its membership check, so a cursor from one resource
replayed against another cannot widen what the caller can read.

Covers `GET /groups`, `/groups/:id/expenses`, `/groups/:id/ledger`,
`/groups/:id/treasury/history`, `/anchors/sessions`, and `/history` (which
paginates its expense and settlement streams independently, via `cursor` and
`settlementCursor`).

## TypeScript strict mode

The whole of `src/` compiles under TypeScript's [`strict`](https://www.typescriptlang.org/tsconfig/#strict) flag — see [tsconfig.json](tsconfig.json) for the exact configuration. `strict` turns on every strict type-checking family at once (`strictNullChecks`, `noImplicitAny`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noImplicitThis`, `alwaysStrict`, and `useUnknownInCatchVariables`), so `null`/`undefined` flows, implicit `any`s, and unbound `this` are compile errors rather than production incidents.

| Setting | Value | Why |
| --- | --- | --- |
| `strict` | `true` | All strict checks on across `src/` — no per-file opt-outs |
| `forceConsistentCasingInFileNames` | `true` | Casing differences cannot break Linux CI builds |
| `noUnusedLocals` | `false` | Deliberate: readability over lint-by-compiler (ESLint's `no-unused-vars` covers it) |
| `noUncheckedIndexedAccess` | `false` | Deliberate: index accesses are guarded where they matter |

CI enforces it: [`npm run build`](CONTRIBUTING.md#pr-checklist) must pass with zero TS errors before a PR merges. When contributing, keep new code strict-clean — narrow unknowns explicitly, annotate catch variables, and never suppress with `any` casts where a real type exists (see [CONTRIBUTING.md](CONTRIBUTING.md#coding-standards)).

## Testing

```bash
npm test
```

Tests run **without a database or network** — Prisma and Horizon are mocked. They
cover the settlement engine (splits, net balances, greedy suggestions), money
math, SEP-10 challenge/verify, signed-XDR validation, and the auth & group routes
via `app.inject`.

## Local API exploration (REST Client)

[docs/api.http](docs/api.http) is a committed request collection for the
[VS Code REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
extension (also compatible with JetBrains HTTP Client). It walks the full happy
path end-to-end:

1. **SEP-10 auth** — challenge & verify (you sign the challenge with your
   Stellar secret key via [Stellar Laboratory](https://laboratory.stellar.org)
   or the SDK)
2. **Create a group**
3. **Add an expense** (equal split)
4. **Attempt settlement** (requires a second group member as payer)
5. **Fetch personal history**

### Getting a token

1. Open `docs/api.http` in VS Code.
2. Run **1. Health Check** to confirm the server is running.
3. Generate a Stellar keypair — use the
   [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=testnet)
   or run:
   ```bash
   node -e "console.log(require('@stellar/stellar-sdk').Keypair.random().secret())"
   ```
4. Replace `GDULW5...` in **2. SEP-10 Challenge** with your public key and send.
5. Copy the `transaction` XDR from the response, sign it with your secret key
   (see instructions in the file), and paste the signed XDR into **3. SEP-10 Verify**.
6. After a successful verify, copy the `token` value and paste it into the
   `@token` variable at the top of the file.

Subsequent requests use `{{token}}` automatically. Response variables
(`@name` / `{{…}}`) chain group and expense IDs for you.

## Deployment

Deploys to **Render / Fly.io / Railway**. Provision Postgres (Neon/Supabase/RDS),
set the env vars, run `npm run prisma:deploy` on release, start the API with
`npm run start`, and run the worker as a separate process (`npm run worker:start`).

## Security

Found a vulnerability? Please report it privately — see [SECURITY.md](SECURITY.md).
This is testnet, unaudited software; don't run it against mainnet with real funds
without your own review.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Open-source public good — issues and PRs
welcome.

## License

[MIT](LICENSE) © 2026 Mergepay contributors.

## Contributors

[![Contributors](https://contrib.rocks/image?repo=mergepay/mergepay-api)](https://github.com/mergepay/mergepay-api/graphs/contributors)
