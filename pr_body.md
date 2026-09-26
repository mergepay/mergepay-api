Feature: Standardize API error responses and structured logging

This draft PR standardizes API error responses across the application and aligns structured logging with the error contract.

Summary of changes:
- Added `src/utils/error-response.ts` providing a canonical `{ error: { code, message, timestamp, requestId?, details? } }` envelope.
- Updated `src/plugins/error-handler.ts` and `src/app.ts` to return the canonical envelope for Zod, Fastify validation, `AppError`, provider/upstream, rate-limit, and not-found handlers.
- Adjusted `onError` hook to log `warn` for expected/operational (4xx) errors and `error` for server (5xx) errors. Include full `err` object only on `error`-level logs.
- Migrated numerous tests to assert the nested `error.code` and `error.details` shape.

Notes:
- I could not run tests locally in this environment because `vitest` is not installed here; CI should run the full test suite once this PR is opened.
- This PR branch is `standardize-error-responses` and includes the changes described above.

Closes: #534

Checklist:
- [x] Add canonical error envelope
- [x] Refactor central error handler and app hook
- [x] Migrate tests to new envelope
- [ ] CI: run tests and fix remaining failures
- [ ] (Optional) Remove any temporary compatibility layers after consumers migrate

Please review and let me know if you want me to iterate on CI failures or keep the PR as a draft until test passing is confirmed by CI.
