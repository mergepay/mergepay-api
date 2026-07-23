# Contributing to Mergepay API

Thanks for helping build an open-source, Stellar-native public good!

## Coding standards

- TypeScript `strict`. Validate **every** request with Zod.
- The API contract is mirrored in `mergepay-web/src/lib/types.ts` — keep them in sync.
- Never store or handle user private keys. Build unsigned XDRs; the wallet signs; validate the signed XDR against the intent before submitting.
- Every group action must check membership; admin-only actions must check the role.
- Write audit logs for state-changing actions.
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

## PR checklist

- [ ] Linked to an issue (`Closes #NN`)
- [ ] `npm run build` passes (zero TS errors)
- [ ] `npm test` passes (no DB/network needed — mock them)
- [ ] New endpoints validated with Zod + permission checks
- [ ] Contract changes mirrored in `mergepay-web`
- [ ] No secrets committed; user private keys never handled

## Tests

Tests must run offline. Mock Prisma (`vi.mock("../src/db")`) and the Stellar
service (`vi.mock("../src/services/stellar")`). Use `app.inject` for route tests.

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

### Integration Test Configuration

The following environment variables can be used to configure integration tests:

| Variable | Description | Default |
|----------|-------------|---------|
| `HORIZON_URL` | Stellar Horizon endpoint | `https://horizon-testnet.stellar.org` |
| `API_BASE_URL` | Base URL of the running API | `http://localhost:3000` |
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
