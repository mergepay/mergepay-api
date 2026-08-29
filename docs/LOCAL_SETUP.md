# Local setup for Mergepay API (Stellar testnet)

This repo is configured to run against the Stellar testnet by default. Do not point local development at mainnet: `STELLAR_NETWORK` and `HORIZON_URL` must match, and the config layer rejects mismatched values.

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

SEP10_SIGNING_SECRET=replace-me-after-running-npm-run-gen:sep10key
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

## Troubleshooting

### Missing env var or startup validation error

If the app exits with a config error, re-check `.env` against [src/config.ts](../src/config.ts) and ensure the required keys are present:

- `DATABASE_URL`
- `PORT`
- `API_PUBLIC_URL`
- `JWT_SECRET`
- `STELLAR_NETWORK`
- `HORIZON_URL`
- `SEP10_SIGNING_SECRET`
- `ANCHOR_HOME_DOMAIN`
- `ANCHOR_NAME`
- `ANCHOR_WEBHOOK_SECRET`
- `STABLE_ASSET_CODE`
- `STABLE_ASSET_ISSUER`

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
- [src/config.ts](../src/config.ts)
- [src/services/sep10.ts](../src/services/sep10.ts)
- [src/services/health.ts](../src/services/health.ts)
