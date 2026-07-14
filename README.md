<div align="center">

# Mergepay — API

**The Stellar-native settlement engine behind Mergepay.**

Authentication, group & expense logic, the settlement engine, Stellar
integration, treasury multisig, anchor (SEP-24) flows, and background jobs.

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
   asset, amount, memo) and rejects mismatches with `xdr_mismatch`, then submits
   to Horizon, stores the tx hash, and marks the expense share `settled`.

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
| GET | `/groups/:id/balances` · `/groups/:id/ledger` | Balances & ledger |
| POST/GET | `/groups/:id/treasury/*` · `/treasury-transactions/:id/confirm` | Treasury |
| GET/POST | `/anchors` · `/anchors/deposit` · `/anchors/withdraw` · `/anchors/sessions/:id/complete` · `/anchors/sessions` · `/anchors/webhook` | Anchors |
| GET | `/history` | Cross-group history |
| POST/GET | `/uploads/receipt` · `/uploads/:file` | Receipts |

All request bodies are validated with Zod; every group action checks membership
(and admin rights where required). Errors are returned as `{ error: { code, message } }`.

## Testing

```bash
npm test
```

Tests run **without a database or network** — Prisma and Horizon are mocked. They
cover the settlement engine (splits, net balances, greedy suggestions), money
math, SEP-10 challenge/verify, signed-XDR validation, and the auth & group routes
via `app.inject`.

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
