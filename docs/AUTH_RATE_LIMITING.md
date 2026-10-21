# Authentication and SEP-10 Rate-Limiting Implementation Report

## Scope

This report describes rate limiting for the unauthenticated authentication entry points used by SEP-10:

- `POST /auth/challenge` creates a challenge transaction for a wallet to sign.
- `POST /auth/verify` validates a signed challenge and issues an application session.

The global API rate limit also applies to these endpoints. Their route-specific limits add tighter, independent budgets for challenge generation and authentication verification.

## Design

Rate-limit configuration is split into three responsibilities:

1. `src/config.ts` defines deployment-overridable thresholds and windows.
2. `src/lib/rate-limit.ts` maps named policies to limits, keys, and Fastify hooks. Routes use `rateLimited(name)` rather than duplicating policy numbers.
3. `src/plugins/rate-limit.ts` registers `@fastify/rate-limit`, its shared counter store, response headers, and standardized 429 error.

`src/app.ts` registers the plugin before loading route plugins. This lets the limiter attach to both the global request lifecycle and each route's selected policy.

## SEP-10 Policies

| Endpoint | Policy | Default budget | Key | Hook |
| --- | --- | --- | --- | --- |
| `POST /auth/challenge` | `authChallenge` | 20 requests per 60 seconds | Resolved client IP | `onRequest` |
| `POST /auth/verify` | `authVerify` | 10 requests per 60 seconds | Resolved client IP | `onRequest` |

The limits are configured through `RATE_LIMIT_AUTH_CHALLENGE_MAX`, `RATE_LIMIT_AUTH_CHALLENGE_WINDOW_MS`, `RATE_LIMIT_AUTH_VERIFY_MAX`, and `RATE_LIMIT_AUTH_VERIFY_WINDOW_MS`. Each value is validated at startup; request counts must be positive integers and time windows must be positive and within the configured maximum.

Challenge generation gets the more generous budget because wallet clients may legitimately request or retry a challenge while a user approves it. Verification is tighter because it performs the actual authentication and should be more resistant to brute-force attempts.

Both endpoints are unauthenticated, so their buckets use Fastify's resolved request IP. The wallet public key is deliberately not used: making throttling behavior depend on the requested account could reveal whether an account is known to the service. The policies have separate key prefixes (`auth.challenge` and `auth.verify`), so exhausting challenge requests does not spend the verification budget, or vice versa.

The policy hook is `onRequest`, which runs before body validation or cryptographic work. Invalid requests therefore count toward the endpoint's abuse budget too.

## Request and Rejection Flow

1. The global limiter and the endpoint's named policy inspect the request before its handler runs.
2. The request IP selects the counter for that policy. Fastify's proxy configuration determines how the resolved IP is obtained; forwarded headers are not trusted unless the server is configured to trust the relevant proxy.
3. Requests within both budgets proceed to the route's Zod validation and SEP-10 service logic.
4. When a route budget is exhausted, Fastify returns HTTP `429 Too Many Requests`; the handler is not called.

Rate-limited responses include `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`, and `retry-after`. The plugin's error builder returns an application error so the normal error handler emits the standard `RATE_LIMITED` response envelope and request ID rather than leaking plugin internals.

## Counter Storage

`RATE_LIMIT_STORE=memory` is the default. Counters are local to a process, which avoids a database query on every request but does not coordinate limits across multiple API instances.

Set `RATE_LIMIT_STORE=database` to use the Prisma-backed rate-limit store and share counters across instances. Database-store failures are configured to fail open (`skipOnError`), keeping a rate-limit storage outage from turning all API requests into server errors. Deployments using this option need the corresponding rate-limit database table and migrations applied.

The in-memory store creates a child store per route, so routes with separate policies remain isolated. In database mode, keys are persisted by policy prefix and resolved client IP, allowing requests to the same policy to share a counter across instances.

## Tests

The implementation is covered at several boundaries:

- `tests/rate-limit-policies.test.ts` checks policy defaults, independent prefixes, IP keying for unauthenticated routes, and the ordering that keeps verification at least as strict as challenge generation.
- `tests/rate-limit-tiers.test.ts` exercises the real application registration and verifies that challenge and verification requests cross their configured budgets with HTTP 429 responses and rate-limit headers. It also verifies that the two auth policies do not consume each other's budgets.
- `tests/rate-limit-wiring.test.ts` inspects the routes registered by the real app and checks that named policies are applied with the policy table's values.
- `tests/rate-limit-sensitive-routes.test.ts` checks the 429 contract across auth and other sensitive endpoints.

Run the focused unit tests with:

```sh
npm test -- tests/rate-limit-policies.test.ts tests/rate-limit-tiers.test.ts tests/rate-limit-wiring.test.ts tests/rate-limit-sensitive-routes.test.ts
```

The integration suite also contains `tests/integration/sep10-auth-rate-limit.test.ts`; it is separate from the default unit-test configuration and is intended for integration-test runs.

## Operational Notes

- Tune the challenge and verification budgets independently through their environment variables; defaults are 20 and 10 requests per minute, respectively.
- Configure trusted proxies deliberately. IP-based limits are only as accurate as Fastify's resolved `request.ip`.
- Use the database store when counters must be shared across multiple server processes; the default in-memory store is process-local.
- Clients should honor `retry-after` and avoid immediate repeated retries after a 429.
