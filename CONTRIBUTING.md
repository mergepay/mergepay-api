# Contributing to Mergepay API

Thanks for helping build an open-source, Stellar-native public good!

## Coding standards

- TypeScript `strict`. The whole of `src/` compiles under the [`strict`](https://www.typescriptlang.org/tsconfig/#strict) flag (see [tsconfig.json](tsconfig.json) and the [TypeScript strict mode](https://github.com/mergepay/mergepay-api#typescript-strict-mode) section in the README for the exact settings and rationale). `npm run build` must pass with zero TS errors — CI runs it on every PR, so strict violations block merge. In practice: narrow `unknown` explicitly, annotate catch variables, prefer real types over `any` casts, and never weaken `tsconfig.json` to make an error go away.
- Validate **every** request with Zod.
- The API contract is mirrored in `mergepay-web/src/lib/types.ts` — keep them in sync.
- Never store or handle user private keys. Build unsigned XDRs; the wallet signs; validate the signed XDR against the intent before submitting.
- Every group action must check membership; admin-only actions must check the role.
- Write audit logs for state-changing actions. Group and treasury mutations use
  the transactional helpers in `src/services/audit.ts` (`auditTx` /
  `logActionTx`) with an action from `src/services/audit-actions.ts`:
  `group.create`, `group.join`, `group.member_remove`,
  `group.member_role_change`, `treasury.proposal.created`,
  `treasury.proposal.signed`, `treasury.proposal.submitted`, and their
  `treasury.tx_proposal.*` equivalents. Metadata carries identifiers, outcomes,
  and before/after values only — never private keys, seeds, tokens, or signed
  envelope bytes.
- Keep Horizon/anchor I/O inside `src/services/*` so it stays mockable.

## Branching model

- `main` is always deployable and green.
- Branch from `main`: `feat/<name>`, `fix/<name>`, `docs/<name>`.

## Issue labels

`bug`, `feature`, `stellar`, `security`, `good first issue`, `docs`, and the Drips
Wave labels `drips-wave` + one of `complexity: trivial | medium | high`
(see [.github/labels.yml](.github/labels.yml)).

## Drips Wave contributors

This repo participates in the Stellar **Drips Wave** program. If you're here for a
Wave task:

1. **Find an issue** labelled `drips-wave` (see also [DRIPS_WAVE.md](DRIPS_WAVE.md)).
2. **Claim it publicly** — comment on the issue to be assigned before you start, so
   work isn't duplicated.
3. **Keep all communication on the issue/PR thread.** No DMs — discussion, questions,
   and decisions stay public and linked to the task.
4. **One PR per issue, and link it** — every PR must reference the issue it
   resolves (`Closes #NN`). PRs not tied to an issue will be asked to open one first.
5. Reward points map to the issue's `complexity:*` label.

## Quickstart

For a local API setup against Stellar testnet, follow the step-by-step guide in
[docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md) (or the
[Local quickstart](README.md#local-quickstart-testnet) in the README).
**`.env.example` ships with public-network defaults** (`STELLAR_NETWORK=public`,
`HORIZON_URL=https://horizon.stellar.org`); for local development override both
to `STELLAR_NETWORK=testnet` and `HORIZON_URL=https://horizon-testnet.stellar.org`.
Do not point local development at mainnet — `STELLAR_NETWORK` and `HORIZON_URL`
must match, and `src/config.ts` rejects a mismatched pair at startup.

```bash
git clone https://github.com/mergepay/mergepay-api.git
cd mergepay-api
npm install
cp .env.example .env
createdb mergepay             # once; then edit .env (testnet overrides, JWT_SECRET, DATABASE_URL)
npm run gen:sep10key          # paste SEP10_SIGNING_SECRET into .env
npm run prisma:generate
npm run prisma:migrate
npm run db:seed
npm run dev                   # API on :4000
npm run worker                # in a second terminal
```

Then verify the local API is healthy:

```bash
curl -sS http://localhost:4000/health
```

Expected: a JSON response with `status` and both dependency checks reporting live values.

## PR checklist

- [ ] Linked to an issue (`Closes #NN`)
- [ ] `npm run build` passes (zero TS errors under `strict` — see [TypeScript strict mode](https://github.com/mergepay/mergepay-api#typescript-strict-mode))
- [ ] `npm test` passes (no DB/network needed — mock them)
- [ ] New endpoints validated with Zod + permission checks
- [ ] Contract changes mirrored in `mergepay-web`
- [ ] No secrets committed; user private keys never handled
- [ ] **Audit logs written for all state-changing endpoints**

## CI Prisma Checks

This section documents the Prisma validation and migration drift checks added in PR #940.

### `prisma:validate`

Run via `npm run prisma:validate`. This command:
- Validates the Prisma schema against the connected database
- Ensures the schema is consistent with the database model
- Fails if there are drift issues between the schema and the database

### `prisma:status`

Run via `npm run prisma:status`. This command:
- Shows the current migration status
- Indicates which migrations have been applied
- Helps identify pending migrations

### `prisma:check-drift`

Run via `npm run prisma:check-drift`. This command:
- Checks for drift between the Prisma schema and the database
- Reports any differences that need to be addressed
- Ensures the database schema matches the expected model

### Local reproduction

- `npm run prisma:validate` — validates the Prisma schema
- `npm run prisma:status` — shows migration status
- `npm run prisma:check-drift` — checks for drift

### Contribution guidelines for audit logging

- **Write audit logs for all state-changing actions** — every group creation, expense settlement, treasury update, and member management action must produce an audit log entry
- Use the centralized `logAction` or `logActionTx` helpers from `src/services/audit.ts`
- `logAction` — best-effort write that never breaks the operation; logs to `audit_logs` table and mirrors to the structured Pino auditor
- `logActionTx` — atomic write inside a caller-managed transaction; audit row commits/rolls back with the mutation
- `logAuditTrail` — non-blocking write for handlers with no transaction to join: it schedules the row and returns immediately, so the response never waits on the database
- `auditTrail` (`src/middleware/audit.ts`) — route-level `onResponse` middleware for state-changing endpoints whose whole state change is the request itself (e.g. `PATCH /me`). It runs after the reply is delivered, records only 2xx state-changing methods, and never reads headers, tokens, or body values
- Never log sensitive material (private keys, bearer tokens, signed XDRs) in audit metadata — the `sanitizeAuditMetadata` function strips these automatically
- Asynchronous logging must not block HTTP response delivery — audit writes are best-effort and errors are swallowed

## Tests

Tests must run offline. Mock Prisma (`vi.mock("../src/db")`) and the Stellar
service (`vi.mock("../src/services/stellar")`). Use `app.inject` for route tests.

Rate limits stay enforced in tests, because the suites that assert them
(`tests/rate-limit-*.test.ts`, `tests/integration/sep10-auth-rate-limit.test.ts`)
only mean something against the real wiring. The budgets are small and they key
on the authenticated *user*, not the client address, so a suite that reuses one
`buildApp()` across a file cannot dodge them by rotating `remoteAddress`: it will
eventually spend a tier and fail an unrelated assertion with a 429. A suite whose
subject is not the limiter may boot without one:

```ts
const app = await buildApp({ rateLimit: "off" });
```

Use it for nothing else. Production callers pass no options and keep the default
(`"enforced"`), and a suite testing throttling, the limit headers or the 429
envelope must leave the limiter in place.

## Integration Tests

Integration tests cover the full user journey from SEP-10 authentication through
group creation, expense addition, and settlement via the Stellar testnet.

### Running Integration Tests

1. Ensure your backend server is running with the test database configuration:
   ```bash
   export DATABASE_URL="postgresql://user:pass@localhost:5432/mergepay_test"
   npm run dev
   ```

2. In a separate terminal, run the integration tests:
   ```bash
   npm run test:integration
   ```

### Database-backed tests

The database-backed tests (`tests/integration/db/` holds the harness) need a
Postgres but no running server and no network. `vitest.integration.config.ts`
registers a global setup/teardown that provisions the schema and empties every
table once per run, so the suite starts from a known-empty database instead of
inheriting whatever the last run left:

```bash
createdb mergepay_test
DATABASE_URL_TEST="postgresql://postgres@localhost:5432/mergepay_test" npm run test:integration
```

The schema is applied with `prisma db push` — the same command `npm run
prisma:deploy` runs — because the committed migration history is not replayable
onto a fresh database; see issue #646. CI provisions the database as a service
container in the `integration` job.

### Integration Test Configuration

The following environment variables can be used to configure integration tests:

| Variable | Description | Default |
|----------|-------------|---------|
| `HORIZON_URL` | Stellar Horizon endpoint | `https://horizon-testnet.stellar.org` (test helper fallback) |
| `API_BASE_URL` | Base URL of the running API | `http://localhost:3000` (test helper fallback) — the API itself listens on **:4000**, so set `API_BASE_URL=http://localhost:4000` when running against a local server |
| `DATABASE_URL_TEST` | Test database connection string | Uses `DATABASE_URL` |

### Integration Test Details

- Tests run against the **public Stellar testnet** by default.
- Test accounts are generated on-the-fly and funded via friendbot.
- No real private keys are used; all keys are ephemeral.
- Tests are idempotent and use unique identifiers to avoid collisions.
- Each test has a 30-second timeout to account for Stellar network latency.
- Expected runtime is under 5 minutes for the full suite.

### Troubleshooting

- If tests fail with network errors, check that the testnet is accessible.
- If friendbot funding fails, the tests include retry logic with backoff.
- Ensure the backend server is fully started before running integration tests.

### CI Prisma Checks

CI validates the Prisma schema and migration state on every PR:

- **`build-test` job** — runs `npm run prisma:validate` after `prisma:generate`. A schema syntax error or invalid relation fails the job before the TypeScript build or test suite runs.
- **`integration` job** — runs `npm run prisma:validate` before the integration suite for consistency.
- **`migration` job** — runs the full migration pipeline:
  1. `npm run prisma:validate` — schema must be syntactically valid
  2. `npx prisma migrate deploy` — the entire committed migration history must deploy cleanly to a fresh Postgres database
  3. `npm run prisma:status` — migration status must be consistent
  4. `npm run prisma:check-drift` — the deployed database state must equal `prisma/schema.prisma` (exit code 0); any diff means migrations drifted from the schema and must be reconciled before merge

Locally, run the same checks before pushing:

```bash
npm run prisma:validate      # schema syntax
npm run prisma:status        # migration status (needs DATABASE_URL)
npm run prisma:check-drift   # schema vs. deployed database (needs DATABASE_URL)
```

### Final Stage
