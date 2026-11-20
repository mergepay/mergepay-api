/**
 * Automated Database Migration Health Check Script (#806).
 *
 * Verifies database migration status and Prisma client schema alignment before
 * API server or worker process deployment.
 *
 * Diagnostic checks:
 * 1. Checks DATABASE_URL configuration and connection health.
 * 2. Validates Prisma schema syntax and model integrity (`prisma validate`).
 * 3. Inspects migration history against target database (`prisma migrate status`).
 * 4. Gracefully catches and describes connection errors (P1001, timeouts, auth failures).
 * 5. Detects failed migrations and schema drift (`prisma migrate diff --exit-code`) (#1081).
 * 6. Exits 0 on clean synced migrations; exits 1 on unapplied migrations, drift or errors.
 *    Pass `--json` for a machine-readable report (used by CI).
 */

import { execSync } from "node:child_process";
import dotenv from "dotenv";

dotenv.config();

export type MigrationHealthStatusCode =
  | "synced"
  | "pending_migrations"
  | "failed_migration"
  | "schema_drift"
  | "schema_invalid"
  | "connection_error"
  | "missing_database_url";

export interface MigrationHealthStatus {
  healthy: boolean;
  statusCode: MigrationHealthStatusCode;
  message: string;
  diagnostics: string[];
  pendingMigrationsCount?: number;
}

export type CommandRunner = (
  cmd: string,
  opts?: { env?: Record<string, string | undefined>; stdio?: "pipe" | "inherit" | "ignore" }
) => string | Buffer;

/** Combined message, stdout and stderr of a failed child process. */
function errorOutput(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { stdout?: unknown; stderr?: unknown };
  return [err.message, e.stdout, e.stderr]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join("\n");
}

/**
 * Parses connection error details from Prisma error messages.
 */
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

/**
 * Executes migration health diagnostics against target database.
 */
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
    };
  }

  // 1. Validate Prisma schema syntax
  try {
    runner("npx prisma validate", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    });
    diagnostics.push("✅ Prisma schema syntax and model relations verified");
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    diagnostics.push("❌ Prisma schema validation failed: Syntax or model error detected");
    return {
      healthy: false,
      statusCode: "schema_invalid",
      message: `Schema validation error: ${errorMsg.slice(0, 200)}`,
      diagnostics,
    };
  }

  // 2. Check Prisma migration status
  try {
    const statusOutput = runner("npx prisma migrate status", {
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: "pipe",
    }).toString();

    // Check if unapplied migrations exist
    if (
      /following migration.*have not yet been applied/i.test(statusOutput) ||
      /unapplied migration/i.test(statusOutput)
    ) {
      const match = statusOutput.match(/(\d+)\s+migration.*have not yet been applied/i);
      const pendingCount = match ? parseInt(match[1], 10) : undefined;
      diagnostics.push("⚠️ Database has pending unapplied migrations");
      return {
        healthy: false,
        statusCode: "pending_migrations",
        message: "Target database is behind: Pending migrations require execution",
        diagnostics,
        pendingMigrationsCount: pendingCount,
      };
    }

    diagnostics.push("✅ Database schema is up to date: All migrations successfully applied");

    // 3. Confirm the migrated database matches schema.prisma (exit 2 = drift).
    try {
      runner(
        'npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --exit-code',
        { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" }
      );
      diagnostics.push("✅ No drift between the database and prisma/schema.prisma");
    } catch (driftErr: unknown) {
      if (/P100[0-3]|P1017|authentication failed/i.test(errorOutput(driftErr))) {
        throw driftErr;
      }
      diagnostics.push("❌ Schema drift detected between the database and prisma/schema.prisma");
      return {
        healthy: false,
        statusCode: "schema_drift",
        message: "Database schema has drifted from prisma/schema.prisma: add a migration to reconcile",
        diagnostics,
      };
    }

    return {
      healthy: true,
      statusCode: "synced",
      message: "Database migration health is optimal. Database is ready for deployment.",
      diagnostics,
    };
  } catch (err: unknown) {
    // `prisma migrate status` exits non-zero when migrations are pending or
    // failed, so its output must be classified before assuming a connection
    // problem.
    const errorText = errorOutput(err);
    if (/failed to apply|migration.*(?:failed|was started but)/i.test(errorText)) {
      diagnostics.push("❌ A migration failed to apply and must be resolved");
      return {
        healthy: false,
        statusCode: "failed_migration",
        message: "Target database has a failed migration: resolve it with `prisma migrate resolve`",
        diagnostics,
      };
    }
    if (/have not yet been applied|unapplied migration/i.test(errorText)) {
      const match = errorText.match(/(\d+)\s+migrations?.*have not yet been applied/i);
      diagnostics.push("⚠️ Database has pending unapplied migrations");
      return {
        healthy: false,
        statusCode: "pending_migrations",
        message: "Target database is behind: Pending migrations require execution",
        diagnostics,
        pendingMigrationsCount: match ? parseInt(match[1], 10) : undefined,
      };
    }
    const connectionReason = parseConnectionError(errorText);

    diagnostics.push(`❌ Migration status check failed: ${connectionReason}`);
    return {
      healthy: false,
      statusCode: "connection_error",
      message: `Database connection error during migration check: ${connectionReason}`,
      diagnostics,
    };
  }
}

/**
 * Formats health report for deployment logging.
 */
export function formatHealthReport(status: MigrationHealthStatus): string {
  const lines: string[] = [
    "==================================================",
    "  MERGEPAY DATABASE MIGRATION HEALTH REPORT (#806) ",
    "==================================================",
  ];

  for (const diagnostic of status.diagnostics) {
    lines.push(`  ${diagnostic}`);
  }

  lines.push("--------------------------------------------------");
  if (status.healthy) {
    lines.push(`  STATUS: HEALTHY (${status.statusCode.toUpperCase()})`);
    lines.push(`  ${status.message}`);
  } else {
    lines.push(`  STATUS: UNHEALTHY (${status.statusCode.toUpperCase()})`);
    lines.push(`  REASON: ${status.message}`);
  }
  lines.push("==================================================");

  return lines.join("\n");
}

if (typeof require !== "undefined" && require.main === module) {
  const result = checkMigrationHealth();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatHealthReport(result)
  );
  if (!result.healthy) {
    process.exit(1);
  }
}
