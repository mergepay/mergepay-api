/**
 * Shared migration health check core (#1140).
 *
 * Extracted from scripts/check-migration-health.ts so the startup guard
 * (`src/lib/startup-migration-check.ts`) can import it without violating the
 * TypeScript `rootDir: "src"` constraint. The CLI entry point and report
 * formatter stay in scripts/check-migration-health.ts; this module only
 * exports what the server-side startup check needs.
 */

import { execSync } from "node:child_process";

export type MigrationHealthStatusCode =
  | "synced"
  | "pending_migrations"
  | "failed_migration"
  | "schema_drift"
  | "drift_check_error"
  | "schema_invalid"
  | "connection_error"
  | "missing_database_url";

export interface MigrationHealthStatus {
  healthy: boolean;
  statusCode: MigrationHealthStatusCode;
  message: string;
  diagnostics: string[];
  remediation?: string[];
  pendingMigrationsCount?: number;
}

export type CommandRunner = (
  cmd: string,
  opts?: { env?: Record<string, string | undefined>; stdio?: "pipe" | "inherit" | "ignore" }
) => string | Buffer;

const DRIFT_PREVIEW_LINES = 12;
const DRIFT_PREVIEW_COMMAND =
  "npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script";
const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi;

function errorOutput(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { stdout?: unknown; stderr?: unknown };
  return [err.message, e.stdout, e.stderr]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join("\n");
}

function exitStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { status?: unknown; exitCode?: unknown; code?: unknown };
  for (const value of [candidate.status, candidate.exitCode, candidate.code]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

export function redactSecrets(text: string, databaseUrl?: string): string {
  let redacted = text;
  if (databaseUrl) {
    redacted = redacted.split(databaseUrl).join("<DATABASE_URL>");
    try {
      const password = new URL(databaseUrl).password;
      if (password) {
        for (const candidate of new Set([password, decodeURIComponent(password)])) {
          if (candidate) redacted = redacted.split(candidate).join("***");
        }
      }
    } catch {
      // Not a parseable URL: the generic credential mask below still applies.
    }
  }
  return redacted.replace(POSTGRES_CREDENTIALS, "$1***$2");
}

export function extractDriftSql(rawOutput: string, databaseUrl?: string): string[] {
  const lines = redactSecrets(rawOutput, databaseUrl)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^(?:\+\+\+|---)/.test(line));

  const sqlLines = lines.filter((line) =>
    /^(?:--|CREATE|ALTER|DROP|COMMENT|RENAME|ADD|SET|UPDATE|INSERT|DELETE|INDEX|CONSTRAINT)\b/i.test(
      line
    )
  );
  const preview =
    sqlLines.length > 0
      ? sqlLines
      : lines.filter((line) => !/^(?:error|prisma|at |command failed|exit code)/i.test(line));
  return preview.slice(0, DRIFT_PREVIEW_LINES);
}

export function summarizeDriftDiagnostics(
  rawOutput: string,
  databaseUrl: string | undefined,
  maxLines = 10
): string[] {
  const redact = (value: string): string => {
    let redacted = databaseUrl ? value.split(databaseUrl).join("<DATABASE_URL>") : value;
    redacted = redacted.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "<DATABASE_URL>");
    redacted = redacted.replace(/(\/\/[^:/@\s]+:)[^@\s]+@/g, "$1<REDACTED>@");
    return redacted.trim();
  };

  const lines: string[] = [];
  for (const rawLine of rawOutput.split(/\r?\n/)) {
    const line = redact(rawLine);
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    if (!line || lines.includes(line)) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
}

export function parseConnectionError(rawError: string): string {
  if (rawError.includes("P1001") || /can't reach database server/i.test(rawError)) {
    return "Database server unreachable: Verify database host, port, and network reachability.";
  }
  if (rawError.includes("P1002") || /timed out/i.test(rawError)) {
    return "Database connection timed out: Server did not respond within timeout limit.";
  }
  if (rawError.includes("P1003") || /database does not exist/i.test(rawError)) {
    return "Target database does not exist on the database server.";
  }
  if (rawError.includes("P1017") || /server closed the connection/i.test(rawError)) {
    return "Database server unexpectedly closed connection.";
  }
  if (/authentication failed|password authentication failed/i.test(rawError)) {
    return "Database authentication failed: Invalid username or password credentials.";
  }
  return "Could not establish connection to the target database.";
}

function remediationFor(statusCode: MigrationHealthStatusCode): string[] {
  switch (statusCode) {
    case "missing_database_url":
      return [
        "Set DATABASE_URL in the environment (or .env) to the PostgreSQL connection string for this deployment.",
        "Re-run `npm run prisma:status` once it is set.",
      ];
    case "schema_invalid":
      return [
        "Run `npx prisma validate` locally to print the exact field/relation that is invalid.",
        "Fix prisma/schema.prisma, then re-run `npm run prisma:status`.",
      ];
    case "pending_migrations":
      return [
        "Apply the pending migrations with `npx prisma migrate deploy`.",
        "If a migration is missing from prisma/migrations, generate and commit it with `npx prisma migrate dev --name describe_your_change`.",
      ];
    case "failed_migration":
      return [
        "Inspect the failed migration in the `_prisma_migrations` table and the deploy log for the underlying SQL error.",
        "Fix the migration, then mark it with `npx prisma migrate resolve --rolled-back <migration_name>` and re-apply with `npx prisma migrate deploy`.",
        "Use `npx prisma migrate resolve --applied <migration_name>` only when the change was applied manually.",
      ];
    case "schema_drift":
      return [
        "Generate a migration that captures the difference: `npx prisma migrate dev --name describe_your_change`.",
        `Preview the SQL that would reconcile the database first: \`${DRIFT_PREVIEW_COMMAND}\`.`,
        "If the database change was intentional and applied outside migrations, create a migration for it and commit both.",
      ];
    case "drift_check_error":
      return [
        `Run \`${DRIFT_PREVIEW_COMMAND}\` manually to see the full error.`,
        "Confirm the installed Prisma CLI supports `--from-schema-datasource` (`npx prisma --version`).",
        "Fix the reported problem and re-run `npm run prisma:check-drift`.",
      ];
    case "connection_error":
      return [
        "Confirm the PostgreSQL server is running and reachable from this machine/container.",
        "Check that DATABASE_URL points at the expected host, port, database and credentials for this environment.",
        "Re-run `npm run prisma:status` after fixing the connection.",
      ];
    case "synced":
      return [];
  }
}

export function checkMigrationHealth(options?: {
  databaseUrl?: string;
  execSyncFn?: CommandRunner;
}): MigrationHealthStatus {
  const runner = options?.execSyncFn ?? execSync;
  const dbUrl = options?.databaseUrl ?? process.env.DATABASE_URL;
  const diagnostics: string[] = [];

  if (!dbUrl) {
    diagnostics.push("❌ DATABASE_URL environment variable is not defined");
    return {
      healthy: false,
      statusCode: "missing_database_url",
      message: "DATABASE_URL is required to perform database migration health checks",
      diagnostics,
      remediation: remediationFor("missing_database_url"),
    };
  }

  // 1. Validate Prisma schema syntax
  try {
    runner("npx prisma validate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    diagnostics.push("✅ Prisma schema syntax and model relations verified");
  } catch {
    diagnostics.push("❌ Prisma schema validation failed: Syntax or model error detected");
    return {
      healthy: false,
      statusCode: "schema_invalid",
      message: "Schema validation error: prisma/schema.prisma is not valid; run `npx prisma validate` for details",
      diagnostics,
      remediation: remediationFor("schema_invalid"),
    };
  }

  // 2. Check Prisma migration status
  try {
    const statusOutput = runner("npx prisma migrate status", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    }).toString();

    if (
      /following migration.*have not yet been applied/i.test(statusOutput) ||
      /\d+\s+migrations?\s+have not yet been applied/i.test(statusOutput) ||
      /unapplied migration/i.test(statusOutput)
    ) {
      const match = statusOutput.match(/(\d+)\s+migration.*have not yet been applied/i);
      const pendingCount = match ? parseInt(match[1], 10) : undefined;
      diagnostics.push("⚠️ Database has pending unapplied migrations");
      if (pendingCount !== undefined) {
        diagnostics.push(`ℹ️ ${pendingCount} migration(s) awaiting application`);
      }
      return {
        healthy: false,
        statusCode: "pending_migrations",
        message: "Target database is behind: Pending migrations require execution",
        diagnostics,
        remediation: remediationFor("pending_migrations"),
        pendingMigrationsCount: pendingCount,
      };
    }

    if (/failed to apply|migration.*was started but/i.test(statusOutput)) {
      diagnostics.push("❌ A migration failed to apply and must be resolved");
      return {
        healthy: false,
        statusCode: "failed_migration",
        message: "Target database has a failed migration: resolve it with `prisma migrate resolve`",
        diagnostics,
        remediation: remediationFor("failed_migration"),
      };
    }

    diagnostics.push("✅ Database schema is up to date: All migrations successfully applied");

    // 3. Confirm the migrated database matches schema.prisma (exit 2 = drift).
    let driftError: unknown;
    try {
      runner(
        "npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code",
        { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" }
      );
      diagnostics.push("✅ No drift between the database and prisma/schema.prisma");
    } catch (driftErr: unknown) {
      driftError = driftErr;
    }

    if (driftError !== undefined) {
      const driftOutput = errorOutput(driftError);
      if (/P100[0-3]|P1017|authentication failed/i.test(driftOutput)) {
        throw driftError;
      }

      const status = exitStatus(driftError);
      if (status !== undefined && status !== 2) {
        diagnostics.push(
          `❌ Drift check could not complete: \`prisma migrate diff\` exited with code ${status}`
        );
        const errorPreview = extractDriftSql(driftOutput, dbUrl);
        for (const line of errorPreview) {
          diagnostics.push(`     ${line}`);
        }
        return {
          healthy: false,
          statusCode: "drift_check_error",
          message:
            "Unable to compare the database with prisma/schema.prisma: the drift check failed to run",
          diagnostics,
          remediation: remediationFor("drift_check_error"),
        };
      }

      diagnostics.push("❌ Schema drift detected between the database and prisma/schema.prisma");
      const driftLines = summarizeDriftDiagnostics(driftOutput, dbUrl);
      if (driftLines.length > 0) {
        diagnostics.push("ℹ️ Differing schema statements (redacted):");
        for (const line of driftLines) diagnostics.push(`   ${line}`);
      }
      const driftSql = extractDriftSql(driftOutput, dbUrl).filter(
        (line) => !driftLines.includes(line)
      );
      if (driftSql.length > 0) {
        diagnostics.push(
          "ℹ️ Drift preview (SQL that reconciles the database with prisma/schema.prisma):"
        );
        for (const line of driftSql) {
          diagnostics.push(`     ${line}`);
        }
        if (driftSql.length === DRIFT_PREVIEW_LINES) {
          diagnostics.push(`ℹ️ Preview truncated; run \`${DRIFT_PREVIEW_COMMAND}\` for the full diff.`);
        }
      }
      if (driftLines.length === 0 && driftSql.length === 0) {
        diagnostics.push("ℹ️ Run `npm run prisma:check-drift` to inspect the full SQL diff.");
      }
      return {
        healthy: false,
        statusCode: "schema_drift",
        message: "Database schema has drifted from prisma/schema.prisma: add a migration to reconcile",
        diagnostics,
        remediation: remediationFor("schema_drift"),
      };
    }

    return {
      healthy: true,
      statusCode: "synced",
      message: "Database migration health is optimal. Database is ready for deployment.",
      diagnostics,
      remediation: remediationFor("synced"),
    };
  } catch (err: unknown) {
    const errorText = errorOutput(err);
    if (/failed to apply|migration.*(?:failed|was started but)/i.test(errorText)) {
      diagnostics.push("❌ A migration failed to apply and must be resolved");
      return {
        healthy: false,
        statusCode: "failed_migration",
        message: "Target database has a failed migration: resolve it with `prisma migrate resolve`",
        diagnostics,
        remediation: remediationFor("failed_migration"),
      };
    }
    if (/have not yet been applied|unapplied migration/i.test(errorText)) {
      const match = errorText.match(/(\d+)\s+migrations?.*have not yet been applied/i);
      const pendingCount = match ? parseInt(match[1], 10) : undefined;
      diagnostics.push("⚠️ Database has pending unapplied migrations");
      if (pendingCount !== undefined) {
        diagnostics.push(`ℹ️ ${pendingCount} migration(s) awaiting application`);
      }
      return {
        healthy: false,
        statusCode: "pending_migrations",
        message: "Target database is behind: Pending migrations require execution",
        diagnostics,
        remediation: remediationFor("pending_migrations"),
        pendingMigrationsCount: pendingCount,
      };
    }

    const connectionReason = parseConnectionError(errorText);
    diagnostics.push(`❌ Migration status check failed: ${connectionReason}`);
    return {
      healthy: false,
      statusCode: "connection_error",
      message: `Database connection error during migration check: ${connectionReason}`,
      diagnostics,
      remediation: remediationFor("connection_error"),
    };
  }
}

/** Formats a migration-health result for deployment logs. */
export function formatHealthReport(status: MigrationHealthStatus): string {
  const lines = [
    "==================================================",
    "  MERGEPAY DATABASE MIGRATION HEALTH REPORT (#806) ",
    "==================================================",
    ...status.diagnostics.map((diagnostic) => `  ${diagnostic}`),
    "--------------------------------------------------",
  ];

  if (status.healthy) {
    lines.push(`  STATUS: HEALTHY (${status.statusCode.toUpperCase()})`);
    lines.push(`  ${status.message}`);
  } else {
    lines.push(`  STATUS: UNHEALTHY (${status.statusCode.toUpperCase()})`);
    lines.push(`  REASON: ${status.message}`);
    if (status.remediation && status.remediation.length > 0) {
      lines.push("  NEXT STEPS:");
      status.remediation.forEach((step, index) => lines.push(`    ${index + 1}. ${step}`));
    }
  }

  lines.push("==================================================");
  return lines.join("\n");
}

/** Testable CLI adapter retained for the existing migration-health script. */
export function runMigrationHealthCli(
  args: readonly string[],
  log: (message: string) => void = (message) => console.log(message),
  exit: (code: number) => void = (code) => process.exit(code),
  options?: Parameters<typeof checkMigrationHealth>[0]
): number {
  const result = checkMigrationHealth(options);
  log(args.includes("--json") ? JSON.stringify(result, null, 2) : formatHealthReport(result));
  const exitCode = result.healthy ? 0 : 1;
  if (exitCode !== 0) exit(exitCode);
  return exitCode;
}
