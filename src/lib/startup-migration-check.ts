/**
 * Startup database migration health guard (#1140).
 *
 * Runs the migration health check once at process startup, after the database
 * connection is established but before the HTTP server accepts traffic.
 * Any unhealthy status causes the wrapper to throw so the caller can close
 * the app cleanly and exit non-zero.
 *
 * Keeping the guard in its own module lets tests mock `checkMigrationHealth`
 * without spawning a process or touching a live database.
 */

import { checkMigrationHealth } from "../../scripts/check-migration-health";

export interface StartupMigrationCheckLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface StartupMigrationCheckOptions {
  databaseUrl?: string;
  logger?: StartupMigrationCheckLogger;
  /** Injected in tests to replace `checkMigrationHealth` without module-level mocking. */
  checkFn?: typeof checkMigrationHealth;
}

/**
 * Verifies migration health before the server opens its port.
 *
 * Resolves silently when the schema is synced; throws an `Error` with the
 * `statusCode` and `message` from the health result for every unhealthy state.
 * The caller in `src/index.ts` catches the error, closes the Fastify app and
 * calls `process.exit(1)`.
 */
export async function runStartupMigrationCheck(
  options: StartupMigrationCheckOptions = {}
): Promise<void> {
  const checkFn = options.checkFn ?? checkMigrationHealth;
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;

  const result = checkFn({ databaseUrl });

  if (!result.healthy) {
    options.logger?.error(
      {
        statusCode: result.statusCode,
        message: result.message,
        diagnostics: result.diagnostics,
        remediation: result.remediation,
      },
      "Database migration health check failed — refusing to start"
    );
    throw new Error(
      `Migration health check failed [${result.statusCode}]: ${result.message}`
    );
  }

  options.logger?.info(
    { statusCode: result.statusCode, diagnostics: result.diagnostics },
    "Database migration health check passed"
  );
}
