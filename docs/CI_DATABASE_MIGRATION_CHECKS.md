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

## Required Environment Variables

| Variable | Description | Example / Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string for Prisma client and migrations | `postgresql://postgres:postgres@localhost:5432/mergepay_test` |
| `DATABASE_URL_TEST` | Test database URL used by integration test runner | `postgresql://postgres:postgres@localhost:5432/mergepay_test` |
| `POSTGRES_USER` | Container database superuser | `postgres` |
| `POSTGRES_PASSWORD` | Container database password | `postgres` |
| `POSTGRES_DB` | Target database name | `mergepay_test` / `mergepay_migration` |
