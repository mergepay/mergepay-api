# CI Database Migration and Schema Validation (#898)

This document details the database migration and schema drift validation checks implemented in the Mergepay API CI pipeline (`.github/workflows/ci.yml`).

## Overview

The CI pipeline runs automated checks across two database-backed jobs:
1. `integration`: Runs integration tests against PostgreSQL 16 after validating the schema, applying all migrations, and ensuring zero drift.
2. `migration`: Validates that the migration history reproduces `prisma/schema.prisma` from a clean slate.

## Pipeline Steps

### 1. Schema Validation
```bash
npm run prisma:validate
```
Fails fast if `prisma/schema.prisma` has syntactic errors, missing relations, or invalid type references before contacting any database.

### 2. Migration Deployment
```bash
npx prisma migrate deploy
```
Applies all pending migrations in order against the test database.

### 3. Migration Status
```bash
npm run prisma:status
```
Verifies that all migrations in `prisma/migrations` are applied and up-to-date. This runs `scripts/check-migration-health.ts`, which also performs the automated drift check below and emits one structured report.

### 4. Schema Drift Detection
```bash
npm run prisma:check-drift
```
Ensures that the deployed database matches `prisma/schema.prisma` with zero uncommitted schema drift.

## Migration Health CLI (#1078)

```bash
npm run db:migration-health
npm run db:migration-health -- --json
```

`scripts/check-migration-health.ts` validates the schema, parses `prisma migrate status` for pending and failed migrations, and compares the database to `prisma/schema.prisma` with `prisma migrate diff --exit-code`. It prints a human-readable report by default, supports `--json` for CI consumers, and exits non-zero for a missing `DATABASE_URL`, invalid schema, connection failure, failed/pending migration, or drift.

The Prisma CLI resolves the datasource URL from `DATABASE_URL` in the child process environment; the connection string is never interpolated into a shell command or printed in diagnostics.

### Drift diagnostics (#1118)

When `prisma migrate diff` reports a difference (exit code 2), the report prints the reconciliation SQL Prisma produced, truncated to a dozen lines, followed by `NEXT STEPS` with the commands that fix it:

```text
  ❌ Schema drift detected between the database and prisma/schema.prisma
  ℹ️ Drift preview (SQL that reconciles the database with prisma/schema.prisma):
       [*] Changed the `expenses` table
       [-] Removed column `drift_probe`
  ...
  NEXT STEPS:
    1. Generate a migration that captures the difference: `npx prisma migrate dev --name describe_your_change`.
    2. Preview the SQL that would reconcile the database first: `npx prisma migrate diff ... --script`.
```

`prisma migrate diff` exit code 2 means "a diff exists". Any other non-zero exit is reported as `drift_check_error` instead of `schema_drift`, because the presence of drift is unknown when the check itself could not run (a bad flag, an unsupported CLI version, an unreadable schema). Connection failures raised during the diff are still reported as `connection_error`. All diagnostic text is passed through credential redaction, so a schema comment or Prisma message containing `DATABASE_URL` or another `postgres://user:password@…` URI never reaches CI logs.

The JSON report carries the same information: `diagnostics` holds the preview lines and `remediation` holds the next steps.

| Status | Exit code | Meaning |
|---|---|---|
| `synced` | 0 | Schema, migrations and database agree |
| `pending_migrations` | 1 | Migrations are committed but not applied |
| `failed_migration` | 1 | A migration is recorded as failed |
| `schema_drift` | 1 | The database differs from `prisma/schema.prisma` |
| `drift_check_error` | 1 | The drift comparison could not run |
| `schema_invalid` | 1 | `prisma validate` rejected the schema |
| `connection_error` | 1 | The database could not be reached |
| `missing_database_url` | 1 | `DATABASE_URL` is not set |

## Required Environment Variables

| Variable | Description | Example / Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string for Prisma client and migrations | `postgresql://postgres:postgres@localhost:5432/mergepay_test` |
| `DATABASE_URL_TEST` | Test database URL used by integration test runner | `postgresql://postgres:postgres@localhost:5432/mergepay_test` |
| `POSTGRES_USER` | Container database superuser | `postgres` |
| `POSTGRES_PASSWORD` | Container database password | `postgres` |
| `POSTGRES_DB` | Target database name | `mergepay_test` / `mergepay_migration` |
