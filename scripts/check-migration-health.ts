/**
 * Automated Database Migration Health Check Script (#806, #1078).
 *
 * Verifies database migration status and Prisma client schema alignment before
 * API server or worker process deployment.
 *
 * Diagnostic checks:
 * 1. Checks DATABASE_URL configuration and connection health.
 * 2. Validates Prisma schema syntax and model integrity (`prisma validate`).
 * 3. Inspects migration history against target database (`prisma migrate status`),
 *    reporting unapplied and failed migrations with an actionable count/status.
 * 4. Gracefully catches and describes connection errors (P1001, timeouts, auth failures).
 * 5. Detects schema drift with `prisma migrate diff --exit-code` (#1081), reading
 *    the datasource URL from the environment rather than the process argv so the
 *    database password never leaks into shell command lines or logs (#1078).
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
 * Reduce `prisma migrate diff` output to the change lines an operator can act
 * on, with every connection string scrubbed.
 *
 * The diff body describes schema objects, not credentials, but a Prisma error
 * can echo the datasource URL, so the URL and any userinfo left in it are
 * redacted before the lines enter diagnostics or CI logs (#1078).
 */
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
    // Change lines only: the `+++`/`---` file headers and context lines add
    // noise without saying what drifted.
    if (!/^[+-]/.test(line) || /^(\+\+\+|---)/.test(line)) continue;
    if (!line || lines.includes(line)) continue;
    lines.push(line);
    if (lines.length >= maxLines) break;
  }
  return lines;
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
  } catch {
    // The raw Prisma error may carry connection details (including parts of
    // DATABASE_URL). Keep it out of the report: `prisma validate` prints the
    // precise syntax diagnostics when the operator runs it locally.
    diagnostics.push("❌ Prisma schema validation failed: Syntax or model error detected");
    return {
      healthy: false,
      statusCode: "schema_invalid",
      message: "Schema validation error: prisma/schema.prisma is not valid; run `npx prisma validate` for details",
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
        pendingMigrationsCount: pendingCount,
      };
    }

    diagnostics.push("✅ Database schema is up to date: All migrations successfully applied");

    // 3. Confirm the migrated database matches schema.prisma (exit 2 = drift).
    // `--from-schema-datasource` makes the Prisma CLI resolve the datasource
    // URL from the DATABASE_URL we pass in `env`. Interpolating the URL into
    // the shell command would expose the password in argv, process listings,
    // and CI logs (#1078).
    try {
      runner(
        "npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --exit-code",
        { env: { ...process.env, DATABASE_URL: dbUrl }, stdio: "pipe" }
      );
      diagnostics.push("✅ No drift between the database and prisma/schema.prisma");
    } catch (driftErr: unknown) {
      const driftOutput = errorOutput(driftErr);
      if (/P100[0-3]|P1017|authentication failed/i.test(driftOutput)) {
        throw driftErr;
      }
      diagnostics.push("❌ Schema drift detected between the database and prisma/schema.prisma");
      const driftLines = summarizeDriftDiagnostics(driftOutput, dbUrl);
      if (driftLines.length > 0) {
        diagnostics.push("ℹ️ Differing schema statements (redacted):");
        for (const line of driftLines) diagnostics.push(`   ${line}`);
      }
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

/**
 * CLI entry point, extracted so the report/exit-code contract is unit-testable
 * without spawning a process or requiring a live database. Returns the code a
 * CI runner should see: 0 for a synced schema, 1 for every unhealthy status.
 */
export function runMigrationHealthCli(
  args: readonly string[],
  log: (message: string) => void = (message) => console.log(message),
  exit: (code: number) => void = (code) => process.exit(code),
  options?: Parameters<typeof checkMigrationHealth>[0]
): number {
  const result = checkMigrationHealth(options);
  log(
    args.includes("--json")
      ? JSON.stringify(result, null, 2)
      : formatHealthReport(result)
  );
  const exitCode = result.healthy ? 0 : 1;
  if (exitCode !== 0) {
    exit(exitCode);
  }
  return exitCode;
}

if (typeof require !== "undefined" && require.main === module) {
  runMigrationHealthCli(process.argv);
}
