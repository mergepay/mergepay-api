<div align="center">

# Mergepay — API

**The Stellar-native settlement engine behind Mergepay.**

Authentication, group & expense logic, the settlement engine, Stellar
integration, treasury multisig, anchor (SEP-24) flows, and background jobs.

[Live app](https://mergepay.vercel.app) ·
[Web repo](https://github.com/mergepay/mergepay-web) ·
[API repo](https://github.com/mergepay/mergepay-api)

![CI](https://github.com/mergepay/mergepay-api/actions/workflows/ci.yml/badge.svg)
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

## Environment variables

See [.env.example](.env.example). Key ones:

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_SECRET` | Secret for signing session JWTs (12h expiry) |
| `STELLAR_NETWORK` | `testnet` or `public` |
| `HORIZON_URL` | Horizon server |
| `SEP10_SIGNING_SECRET` | Server's SEP-10 signing key (`npm run gen:sep10key`) |
| `WEB_URL` | Frontend origin (CORS + invite links) |
| `ANCHOR_HOME_DOMAIN` | SEP-24 anchor home domain (default SDF test anchor) |
| `ANCHOR_WEBHOOK_SECRET` | Shared secret for the anchor webhook |
| `STABLE_ASSET_CODE` / `STABLE_ASSET_ISSUER` | Stable asset for settlement |

### Rate limiting

Every route is covered by a global default limit
(`RATE_LIMIT_GLOBAL_MAX` / `RATE_LIMIT_GLOBAL_WINDOW_MS`, default 100 per
minute), plus route-appropriate overrides for endpoints with different
traffic patterns or trust boundaries:

| Route(s) | Variables | Default |
| --- | --- | --- |
| `POST /auth/challenge` | `RATE_LIMIT_AUTH_CHALLENGE_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /auth/verify` | `RATE_LIMIT_AUTH_VERIFY_MAX` / `_WINDOW_MS` | 10 / 1 min |
| `POST /expenses/:id/settle`, `POST /groups/:id/settlements`, `POST /groups/:id/treasury/deposit`, `POST /groups/:id/treasury/withdraw` | `RATE_LIMIT_SETTLEMENT_CREATE_MAX` / `_WINDOW_MS` | 20 / 1 min |
| `POST /settlements/:id/confirm` | `RATE_LIMIT_SETTLEMENT_CONFIRM_MAX` / `_WINDOW_MS` | 30 / 1 min |
| `POST /treasury-transactions/:id/confirm` | `RATE_LIMIT_TREASURY_SUBMIT_MAX` / `_WINDOW_MS` | 30 / 1 min |
| `POST /anchors/deposit`, `POST /anchors/withdraw`, `POST /anchors/sessions/:id/complete` | `RATE_LIMIT_ANCHOR_INIT_MAX` / `_WINDOW_MS` | 10 / 1 min |
| `GET /anchors`, `GET /anchors/sessions` | `RATE_LIMIT_ANCHOR_POLL_MAX` / `_WINDOW_MS` | 60 / 1 min |
| `POST /anchors/webhook` | `RATE_LIMIT_ANCHOR_WEBHOOK_MAX` / `_WINDOW_MS` | 60 / 1 min |
| `POST /groups` | `RATE_LIMIT_GROUP` | 30 / 1 min |
| `GET /history` | `RATE_LIMIT_HISTORY` | 60 / 1 min |

**Tuning a deployment.** Every value above is an environment variable with a
safe default, so a deployment overrides only what it needs — for example a
wallet integration that legitimately retries submissions can raise
`RATE_LIMIT_SETTLEMENT_CONFIRM_MAX` without loosening SEP-10 or anchor
budgets. Windows are milliseconds and capped at one hour; maximums must be
positive integers, so a typo cannot silently disable limiting. The single
source of truth for which route gets which policy is the table in
[src/lib/rate-limit.ts](src/lib/rate-limit.ts); routes name a policy rather
than repeating numbers, and each policy has its own key prefix, which is what
makes the buckets independent.

Every route above has a bucket separate from ordinary authenticated reads, so
exhausting a submission or anchor budget never blocks a client from reading its
own groups, expenses, or settlement status.

Limit keys are the authenticated user's internal id when available
(never a Stellar public key), or the resolved client IP otherwise —
`req.ip` does not trust `X-Forwarded-For` unless Fastify's `trustProxy`
option is explicitly enabled, which this app does not do by default. If
you deploy behind a reverse proxy or load balancer and want per-client
(rather than per-proxy) limiting, enable `trustProxy` in `src/app.ts` and
make sure only your proxy can reach the app directly.

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
`Retry-After` / `X-RateLimit-*` headers.

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

The background worker tracks job claims and retry attempts for settlement
submissions and anchor polling. In the event of a worker crash or deployment
interruption, stale jobs (claimed for longer than 15 minutes) are automatically
recovered and re-eligible for processing. Job state is tracked via:

- `jobAttemptCount`: Number of times the job has been claimed for processing
- `jobClaimedAt`: Timestamp when the job was last claimed (null if released)
- `jobEligibleAt`: Earliest time the job is eligible for the next retry attempt
- `jobErrorSummary`: Truncated error message from the last attempt (for operator review)

Terminal failures (exhausted retries, permanent errors) are marked with status
`failed` and retain an error summary for support investigation. Each job has
a maximum of 5 attempts with exponential backoff (5s, 30s, 5m, 30m, 60m).

## How it works

### SEP-10 login
`POST /auth/challenge` builds a challenge transaction signed by the server key.
The wallet signs it; `POST /auth/verify` validates the signature (handling
unfunded accounts via the master key), upserts the user, and returns a JWT.

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
