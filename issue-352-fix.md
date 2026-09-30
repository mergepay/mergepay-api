# Rate limiting for SEP-10 authentication endpoints (Closes #352)

## Summary

`POST /auth/challenge` and `POST /auth/verify` — the two unauthenticated,
credential-bearing endpoints of the SEP-10 wallet login flow — are bounded by
`@fastify/rate-limit`. Challenge generation and token exchange each get their
own per-route, IP-keyed budget, reject with the standard rate-limit headers and
the API's clean JSON `RATE_LIMITED` envelope once the budget is spent, and are
covered by integration tests that drive the booted application past those
budgets and assert a `429`.

The limiter was previously registered and wired globally; this change closes
out #352 by making the SEP-10-specific coverage explicit in the integration
layer (`tests/integration/`, run by `npm run test:integration`) and by auditing
the configuration, hooks, and error contract against the issue's acceptance
criteria.

## What the SEP-10 endpoints enforce

The tiers live in a single table (`src/lib/rate-limit.ts`) so no route hand-rolls
its numbers; `src/routes/auth.ts` names the policy next to the handler it
protects:

| Route | Policy | Default budget | Bucket key |
| --- | --- | --- | --- |
| `POST /auth/challenge` | `authChallenge` | 20 requests / 60 s | client IP |
| `POST /auth/verify` | `authVerify` | 10 requests / 60 s | client IP |
| `POST /auth/refresh` | `authVerify` | 10 requests / 60 s | client IP |

- **Why challenge is looser than verify.** Requesting a challenge is cheap and
  legitimately retried (a wallet extension polls while the user approves);
  verifying is the actual authentication step, so it is kept tighter to slow
  brute force.
- **Why both are keyed strictly by IP.** There is no authenticated user yet, and
  the wallet's public key must never become a bucket key — differing `429`
  behaviour per public key would reveal whether an account is known to the API.
- **Why they are separate buckets.** A client hammering challenge generation
  cannot lock itself out of verification (and vice versa), which
  `tests/integration/sep10-auth-rate-limit.test.ts` asserts directly.
- **Not global.** Each response advertises its own policy `max` via
  `X-RateLimit-Limit`, not the looser global default, which is what proves the
  per-route config reached the route.

## Rate limit headers and error response

Registration in `src/plugins/rate-limit.ts` turns on the standard headers for
every reply and routes over-budget requests through the central error handler:

- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` on every
  response.
- `Retry-After` on a rejection.
- `429` JSON body shaped like every other API error —
  `{ code: "RATE_LIMITED", message, requestId }` — because the plugin's
  `errorResponseBuilder` returns a real `AppError` rather than a bare payload
  object (a plain object would bypass the handler and surface as a `500`).

## Acceptance criteria

| Criterion | Where it is satisfied |
| --- | --- |
| Configure rate limiting parameters for SEP-10 routes | `RATE_LIMIT_AUTH_CHALLENGE_MAX` / `_WINDOW_MS` and `RATE_LIMIT_AUTH_VERIFY_MAX` / `_WINDOW_MS` in `src/config.ts` (Zod-validated, environment-overridable); resolved through the `authChallenge` / `authVerify` policies in `src/lib/rate-limit.ts`. |
| Apply rate limit hooks or route configurations in the auth module | `src/routes/auth.ts` spreads `rateLimited("authChallenge")` / `rateLimited("authVerify")` into the route options, which carry `max`, `timeWindow`, `hook`, and `keyGenerator`. |
| Add integration tests verifying a `429` when the limit is exceeded | New `tests/integration/sep10-auth-rate-limit.test.ts` (boots the real app, exercises both endpoints past budget, asserts the `429` contract). Additional coverage in `tests/rate-limit-sensitive-routes.test.ts`, `tests/rate-limit-tiers.test.ts`, `tests/rateLimit.test.ts`, and `tests/rate-limit-wiring.test.ts`. |

## Changes in this PR

- **Added `tests/integration/sep10-auth-rate-limit.test.ts`** — five
  integration cases against the booted application:
  1. `POST /auth/challenge` serves every request inside its budget and returns
     `429` on the one that crosses it, with `X-RateLimit-Limit` /
     `X-RateLimit-Remaining: 0` / `X-RateLimit-Reset` / `Retry-After` and the
     `RATE_LIMITED` + `requestId` JSON envelope.
  2. The same for `POST /auth/verify`.
  3. Each route advertises its own policy `max` rather than the global default.
  4. The challenge and verify budgets are independent.
  5. Buckets are keyed by client IP: one exhausted address does not consume
     another's allowance.
- **Added this file** (`issue-352-fix.md`) as the PR summary, per the
  repository's existing `issue-<n>-fix.md` convention.

No production code needed to change: the behaviour the issue asks for is
already implemented and was verified end-to-end while writing the tests.

## Testing

```bash
npm test                                 # 180 files, 3657 tests — all pass
npm run test:integration                 # includes the new suite
npx tsc -p tsconfig.json --noEmit        # no type errors
```

The new suite needs neither a database nor Horizon: a challenge request is built
in-process, and a verify request with an empty body is rejected by Zod request
validation before any cryptographic work or upstream call, so the only variable
under test is the limiter.

Closes #352
