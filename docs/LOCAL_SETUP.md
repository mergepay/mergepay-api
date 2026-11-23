# Local setup for Mergepay API (Stellar testnet)

Local development should run against the Stellar **testnet**. Note that
[.env.example](../.env.example) ships with the safe *public-network* defaults
(`STELLAR_NETWORK=public`, `HORIZON_URL=https://horizon.stellar.org`), so you
must override **both** values as shown below. Do not point local development at
mainnet: `STELLAR_NETWORK` and `HORIZON_URL` must match, and the config layer
([src/config.ts](../src/config.ts)) rejects mismatched values at startup.

## Prerequisites

- Node.js 20+
- PostgreSQL 14+ running on `localhost:5432`
- A local database named `mergepay` (or update `DATABASE_URL` in `.env`)

## 1) Install and create your env file

```bash
git clone https://github.com/mergepay/mergepay-api.git
cd mergepay-api
npm install
cp .env.example .env
```

Edit `.env` and set the required values for a local testnet run:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mergepay
PORT=4000
API_PUBLIC_URL=http://localhost:4000
WEB_URL=http://localhost:3000
JWT_SECRET=replace-this-with-a-long-random-secret
JWT_ISSUER=mergepay-api
JWT_AUDIENCE=mergepay-app

STELLAR_NETWORK=testnet
HORIZON_URL=https://horizon-testnet.stellar.org

# Generate with: npm run gen:sep10key — then paste the printed secret here
SEP10_SIGNING_SECRET=S...
ANCHOR_HOME_DOMAIN=testanchor.stellar.org
ANCHOR_NAME=Stellar Test Anchor
ANCHOR_WEBHOOK_SECRET=change-me
STABLE_ASSET_CODE=USDC
STABLE_ASSET_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN

# keep the defaults unless you need a custom local setup
RATE_LIMIT_STORE=memory
NODE_ENV=development
```

> The repo’s real env schema is defined in [src/config.ts](../src/config.ts), and the baseline defaults live in [.env.example](../.env.example). Keep the same keys; do not invent extra variables.

## 2) Generate the SEP-10 signing key

```bash
npm run gen:sep10key
```

This prints a value like:

```text
SEP10_SIGNING_SECRET=S... 
# public key: G...
```

Copy the `SEP10_SIGNING_SECRET` value into `.env`, then keep `STELLAR_NETWORK=testnet` and `HORIZON_URL=https://horizon-testnet.stellar.org`.

`SEP10_SIGNING_SECRET` is technically optional in `src/config.ts` — when unset,
a random key is generated per process — but setting a stable key is strongly
recommended locally so issued challenges survive an API restart (`npm run dev`
restarts on every file change).

## 3) Prepare the database

If your local Postgres instance does not already have the `mergepay` database, create it once:

```bash
createdb mergepay 2>/dev/null || psql -d postgres -c "CREATE DATABASE mergepay;"
```

Then run the Prisma migration and seed scripts:

```bash
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
```

The seed script is idempotent — run it as often as you like. It upserts
sample users, groups, expenses, settlements and treasury rows instead of
duplicating them, so a second run never trips a unique constraint. What it
creates (demo accounts, invite code, settlement short codes) is documented in
[Seed data](../README.md#seed-data).

On a throwaway database you can sync the schema straight from
`prisma/schema.prisma` instead of replaying migration history:

```bash
npm run prisma:deploy   # prisma db push — never point this at a database with data you care about
npm run db:seed
```

## 4) Start the API and worker

Open two terminals.

Terminal 1:

```bash
npm run dev
```

Terminal 2:

```bash
npm run worker
```

The API listens on `http://localhost:4000` by default.

Both processes shut down gracefully on Ctrl-C (`SIGINT`/`SIGTERM`), tunable via
two env knobs (issue #1038, defaults shown in [.env.example](../.env.example)):

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHUTDOWN_TIMEOUT_MS` | 30000 | API hard timeout: how long `app.close()` may take to finish in-flight requests before the process force-exits. |
| `WORKER_SHUTDOWN_DRAIN_MS` | 30000 | Worker drain budget: how long shutdown waits for the in-flight cycle before leaving job leases to expire on their own. The worker's overall hard timeout is `WORKER_SHUTDOWN_DRAIN_MS + SHUTDOWN_TIMEOUT_MS`. |

## 5) Verify it works

```bash
curl -sS http://localhost:4000/health
```

Expected result: a JSON response with `status` plus dependency checks. A healthy local setup should look like this shape:

```json
{
  "status": "ok",
  "database": { "connected": true },
  "stellar": { "reachable": true, "network": "testnet" }
}
```

If the app has just started and the DB or Horizon is still warming up, it may briefly return `status: "degraded"` with `connected: false` or `reachable: false`. Once Postgres and Horizon are healthy, the endpoint should settle to `ok`.

Other probes worth knowing:

```bash
curl -sS http://localhost:4000/health/live   # process liveness — contacts nothing external
curl -sS http://localhost:4000/health/ready  # cached readiness with per-dependency checks
curl -sS http://localhost:4000/health/deep   # uncached dependency checks with latency
```

To verify the toolchain end-to-end, run `npm run build` (zero TS errors) and
`npm test` (offline unit/route tests). Database-backed integration tests are
covered in [docs/INTEGRATION_TESTING_GUIDE.md](INTEGRATION_TESTING_GUIDE.md).

## Troubleshooting

### Missing env var or startup validation error

If the app exits with a config error, re-check `.env` against [src/config.ts](../src/config.ts) and ensure the required keys are present:

- `DATABASE_URL`
- `API_PUBLIC_URL`
- `JWT_SECRET` (at least 16 characters)
- `STELLAR_NETWORK` (must match `HORIZON_URL`)
- `HORIZON_URL`
- `ANCHOR_HOME_DOMAIN`
- `ANCHOR_NAME`
- `ANCHOR_WEBHOOK_SECRET`
- `STABLE_ASSET_CODE`
- `STABLE_ASSET_ISSUER`

`PORT` defaults to 4000. `SEP10_SIGNING_SECRET` is optional (random fallback)
but recommended — see step 2.

### Postgres is unreachable

`npm run prisma:migrate` or `/health` will fail if Postgres is not running or the DB is missing.

Check:

```bash
pg_isready -h localhost -p 5432
```

If it fails, start PostgreSQL locally or fix the `DATABASE_URL` value in `.env`.

### Horizon rate limit or transient failure

The app uses testnet Horizon endpoints and can rate-limit or briefly fail during upstream instability. Re-check:

```bash
curl -sS https://horizon-testnet.stellar.org
```

If Horizon returns a rate-limit or timeout response, wait a minute and retry. This is expected during bursts, and the app’s retry logic is intended to recover from transient errors without retrying payment submission.

## Deeper docs

- [README.md](../README.md)
- [CONTRIBUTING.md](../CONTRIBUTING.md)
- [docs/api-contract.md](api-contract.md) — error envelope, codes, pagination
- [docs/api.http](api.http) — REST Client request collection
- [docs/INTEGRATION_TESTING_GUIDE.md](INTEGRATION_TESTING_GUIDE.md)
- [src/config.ts](../src/config.ts)
- [src/services/sep10.ts](../src/services/sep10.ts)
- [src/services/health.ts](../src/services/health.ts)
