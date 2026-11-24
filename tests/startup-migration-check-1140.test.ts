/**
 * Startup migration health check wrapper unit tests (#1140).
 *
 * Verifies that `runStartupMigrationCheck` integrates with `checkMigrationHealth`
 * correctly during server startup:
 *   - Resolves silently when the database schema is synced.
 *   - Throws with a descriptive message for every unhealthy status code.
 *   - Calls the logger with the right level (info on pass, error on failure).
 *   - Passes the databaseUrl option through to the health check function.
 *
 * Uses the `checkFn` injection point so no live database, Prisma CLI, or
 * process.env.DATABASE_URL is required.
 */
import { describe, it, expect, vi } from "vitest";
import { runStartupMigrationCheck } from "../src/lib/startup-migration-check";
import type { MigrationHealthStatus } from "../scripts/check-migration-health";

const DB_URL = "postgresql://user:secret@db:5432/app";

function makeStatus(overrides: Partial<MigrationHealthStatus>): MigrationHealthStatus {
  return {
    healthy: true,
    statusCode: "synced",
    message: "All good",
    diagnostics: [],
    remediation: [],
    ...overrides,
  };
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe("runStartupMigrationCheck — synced / healthy (#1140)", () => {
  it("resolves without throwing when the schema is synced", async () => {
    const checkFn = vi.fn().mockReturnValue(makeStatus({ healthy: true, statusCode: "synced" }));
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).resolves.toBeUndefined();
  });

  it("logs info once on a healthy result", async () => {
    const checkFn = vi.fn().mockReturnValue(makeStatus({ healthy: true }));
    const logger = { info: vi.fn(), error: vi.fn() };
    await runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn, logger });
    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("passes the databaseUrl to the check function", async () => {
    const checkFn = vi.fn().mockReturnValue(makeStatus({ healthy: true }));
    await runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn });
    expect(checkFn).toHaveBeenCalledWith(expect.objectContaining({ databaseUrl: DB_URL }));
  });

  it("falls back to process.env.DATABASE_URL when databaseUrl is omitted", async () => {
    const checkFn = vi.fn().mockReturnValue(makeStatus({ healthy: true }));
    process.env.DATABASE_URL = DB_URL;
    try {
      await runStartupMigrationCheck({ checkFn });
    } finally {
      delete process.env.DATABASE_URL;
    }
    expect(checkFn).toHaveBeenCalledWith(
      expect.objectContaining({ databaseUrl: DB_URL })
    );
  });
});

// ── Unhealthy: pending_migrations ─────────────────────────────────────────────

describe("runStartupMigrationCheck — pending_migrations (#1140)", () => {
  it("throws when there are pending migrations", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({
        healthy: false,
        statusCode: "pending_migrations",
        message: "2 pending migrations",
        diagnostics: ["⚠️ Pending"],
        remediation: ["Run prisma migrate deploy"],
      })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/pending_migrations/);
  });

  it("logs error (not info) on unhealthy result", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "pending_migrations", message: "pending" })
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    await runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn, logger }).catch(() => {});
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("includes statusCode and message in the thrown error", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({
        healthy: false,
        statusCode: "pending_migrations",
        message: "Target database is behind",
      })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/pending_migrations.*Target database is behind/);
  });
});

// ── Unhealthy: schema_drift ───────────────────────────────────────────────────

describe("runStartupMigrationCheck — schema_drift (#1140)", () => {
  it("throws for schema_drift with the correct status code in the message", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({
        healthy: false,
        statusCode: "schema_drift",
        message: "Database has drifted from schema.prisma",
      })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/schema_drift/);
  });
});

// ── Unhealthy: failed_migration ───────────────────────────────────────────────

describe("runStartupMigrationCheck — failed_migration (#1140)", () => {
  it("throws for failed_migration", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "failed_migration", message: "Migration failed" })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/failed_migration/);
  });
});

// ── Unhealthy: schema_invalid ─────────────────────────────────────────────────

describe("runStartupMigrationCheck — schema_invalid (#1140)", () => {
  it("throws for schema_invalid", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "schema_invalid", message: "Schema syntax error" })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/schema_invalid/);
  });
});

// ── Unhealthy: missing_database_url ──────────────────────────────────────────

describe("runStartupMigrationCheck — missing_database_url (#1140)", () => {
  it("throws for missing_database_url", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "missing_database_url", message: "No DATABASE_URL" })
    );
    await expect(
      runStartupMigrationCheck({ checkFn })
    ).rejects.toThrow(/missing_database_url/);
  });
});

// ── Unhealthy: connection_error ───────────────────────────────────────────────

describe("runStartupMigrationCheck — connection_error (#1140)", () => {
  it("throws for connection_error", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "connection_error", message: "Cannot connect" })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/connection_error/);
  });

  it("includes diagnostics in the error log on connection_error", async () => {
    const diagnostics = ["❌ P1001: db.internal not reachable"];
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "connection_error", message: "Cannot connect", diagnostics })
    );
    const logger = { info: vi.fn(), error: vi.fn() };
    await runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn, logger }).catch(() => {});
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ diagnostics }),
      expect.any(String)
    );
  });
});

// ── Unhealthy: drift_check_error ──────────────────────────────────────────────

describe("runStartupMigrationCheck — drift_check_error (#1140)", () => {
  it("throws for drift_check_error", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "drift_check_error", message: "Diff check failed" })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/drift_check_error/);
  });
});

// ── Logger is optional ────────────────────────────────────────────────────────

describe("runStartupMigrationCheck — no logger provided (#1140)", () => {
  it("resolves without throwing when no logger is provided and schema is synced", async () => {
    const checkFn = vi.fn().mockReturnValue(makeStatus({ healthy: true }));
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).resolves.toBeUndefined();
  });

  it("throws without throwing a secondary error when no logger is provided and unhealthy", async () => {
    const checkFn = vi.fn().mockReturnValue(
      makeStatus({ healthy: false, statusCode: "schema_drift", message: "drifted" })
    );
    await expect(
      runStartupMigrationCheck({ databaseUrl: DB_URL, checkFn })
    ).rejects.toThrow(/schema_drift/);
  });
});
