/**
 * Automated Database Migration Health Check Script (#806, #1078, #1118).
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
 * 6. Reports schema drift with the SQL that would reconcile it and the exact
 *    commands that resolve it, and separates "drift found" from "drift check
 *    could not run" so a broken `migrate diff` invocation is never mistaken for
 *    a clean schema (#1118).
 * 7. Exits 0 on clean synced migrations; exits 1 on unapplied migrations, drift,
 *    a failed drift check or any other error.
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
  | "drift_check_error"
  | "schema_invalid"
  | "connection_error"
  | "missing_database_url";

export interface MigrationHealthStatus {
  healthy: boolean;
  statusCode: MigrationHealthStatusCode;
  message: string;
  diagnostics: string[];
  /**
   * Concrete commands an operator can run to resolve this status. Populated
   * for every unhealthy result so CI logs and JSON consumers do not have to
   * translate the status code into a fix themselves (#1118).
   */
  remediation?: string[];
  pendingMigrationsCount?: number;
}

export type CommandRunner = (
  cmd: string,
  opts?: { env?: Record<string, string | undefined>; stdio?: "pipe" | "inherit" | "ignore" }
) => string | Buffer;

/** How many lines of drift SQL are echoed before the report is truncated. */
const DRIFT_PREVIEW_LINES = 12;

/** Preview command an operator runs to see the full, untruncated diff. */
const DRIFT_PREVIEW_COMMAND =
  "npx prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script";

/** `postgres://user:password@host/db` credentials, matched anywhere in text. */
const POSTGRES_CREDENTIALS = /(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+(@)/gi;

/** Combined message, stdout and stderr of a failed child process. */
function errorOutput(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const e = err as Error & { stdout?: unknown; stderr?: unknown };
  return [err.message, e.stdout, e.stderr]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v))
    .join("\n");
}

/** Numeric exit status of a failed child process, when one can be determined. */
function exitStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const candidate = err as { status?: unknown; exitCode?: unknown; code?: unknown };
  for (const value of [candidate.status, candidate.exitCode, candidate.code]) {
    if (typeof value === "number") return value;
  }
  return undefined;
}

/**
 * Removes connection credentials from diagnostic text.
 *
 * Drift SQL and Prisma error messages are attacker-adjacent input: a schema
 * comment can contain anything, and `prisma migrate diff` occasionally echoes
 * the datasource it resolved. The report is copied into CI logs, so redact the
 * supplied URL, its password, and any postgres URI credentials before the text
 * leaves this module (#1078, #1118).
 */
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

/**
 * Extracts the SQL statements from a failed `prisma migrate diff` run.
 *
 * For `--from-schema-datasource … --to-schema-datamodel …` Prisma prints the
 * DDL that would bring the database in line with `schema.prisma`, which is
 * exactly what the reader needs to decide whether to generate a migration or
 * investigate a manual database change. Non-SQL boilerplate is discarded and
 * the preview is capped so the report stays readable in a CI log.
 */
export function extractDriftSql(rawOutput: string, databaseUrl?: string): string[] {
  const lines = redactSecrets(rawOutput, databaseUrl)
    .split(/\r?\n/)
    .map((line) => line.trim())
    // Unified-diff file headers (`+++`/`---` plus the `--- a/...` form) name
    // the file but say nothing about what drifted.
    .filter((line) => line.length > 0 && !/^(?:\+\+\+|---)/.test(line));

  const sqlLines = lines.filter((line) =>
    /^(?:--|CREATE|ALTER|DROP|COMMENT|RENAME|ADD|SET|UPDATE|INSERT|DELETE|INDEX|CONSTRAINT)\b/i.test(
      line
    )
  );
  // An unrecognised Prisma version may print the diff in another shape. Fall
  // back to any non-boilerplate line rather than silently showing nothing.
  const preview =
    sqlLines.length > 0
      ? sqlLines
      : lines.filter((line) => !/^(?:error|prisma|at |command failed|exit code)/i.test(line));
  return preview.slice(0, DRIFT_PREVIEW_LINES);
}

/**
 * Next commands for a status. Kept in one place so the human report and the
 * `--json` report stay in sync.
 */
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
    // The raw Prisma error may carry connection details (including parts of
    // DATABASE_URL). Keep it out of the report: `prisma validate` prints the
    // precise syntax diagnostics when the operator runs it locally.
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
        remediation: remediationFor("pending_migrations"),
        pendingMigrationsCount: pendingCount,
      };
    }

    // A failed migration does not always make `migrate status` exit non-zero
    // (for example when another migration is still pending), so classify the
    // output before declaring the history healthy.
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
    // `--from-schema-datasource` makes the Prisma CLI resolve the datasource
    // URL from the DATABASE_URL we pass in `env`. Interpolating the URL into
    // the shell command would expose the password in argv, process listings,
    // and CI logs (#1078).
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
      // `prisma migrate diff --exit-code` signals "a diff exists" with exit
      // code 2. Anything else is a broken invocation (bad flag, broken CLI,
      // unreadable schema) where the presence or absence of drift is unknown;
      // reporting that as drift would send the reader chasing the wrong fix
      // (#1118). When the runner exposes no numeric status (custom runners in
      // tests), fall back to the previous behaviour and treat it as drift.
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
      // `migrate diff` prints DDL for some Prisma versions and `+/-` model
      // context for others. The summary above handles the latter; add any SQL
      // statements it did not already cover so the reader always sees what
      // would reconcile the database with schema.prisma.
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
    if (status.remediation && status.remediation.length > 0) {
      lines.push("  NEXT STEPS:");
      status.remediation.forEach((step, index) => lines.push(`    ${index + 1}. ${step}`));
    }
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
