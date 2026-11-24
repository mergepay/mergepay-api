import { describe, expect, it, vi } from "vitest";
import {
  checkMigrationHealth,
  runMigrationHealthCli,
} from "../../scripts/check-migration-health";

const DB_URL = "postgresql://migration_user:super-secret@db.internal:5432/mergepay";

describe("migration health CLI (#1078)", () => {
  it("runs drift detection without putting DATABASE_URL in the command line", () => {
    const commands: string[] = [];
    let childEnv: Record<string, string | undefined> | undefined;

    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: (cmd, opts) => {
        commands.push(cmd);
        if (cmd.includes("migrate diff")) childEnv = opts?.env;
        return "";
      },
    });

    expect(result.statusCode).toBe("synced");
    const drift = commands.find((cmd) => cmd.includes("migrate diff"));
    expect(drift).toContain("--from-schema-datasource prisma/schema.prisma");
    expect(drift).toContain("--exit-code");
    expect(drift).not.toContain("$DATABASE_URL");
    expect(drift).not.toContain("super-secret");
    expect(childEnv?.DATABASE_URL).toBe(DB_URL);
  });

  it("never echoes raw Prisma errors that could carry connection details", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: (cmd) => {
        if (cmd.includes("prisma validate")) {
          throw new Error(`Invalid schema at ${DB_URL}`);
        }
        return "";
      },
    });

    expect(result.statusCode).toBe("schema_invalid");
    expect(result.message).not.toContain("super-secret");
    expect(result.diagnostics.join("\n")).not.toContain("super-secret");
  });

  it("reports how many migrations are pending", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: (cmd) => {
        if (cmd.includes("prisma migrate status")) {
          return "3 migrations have not yet been applied: a, b, c";
        }
        return "";
      },
    });

    expect(result.statusCode).toBe("pending_migrations");
    expect(result.pendingMigrationsCount).toBe(3);
    expect(result.diagnostics).toContain("ℹ️ 3 migration(s) awaiting application");
  });

  it("prints a JSON report and returns 0 for a healthy database", () => {
    const log = vi.fn();
    const exit = vi.fn();

    const code = runMigrationHealthCli(
      ["node", "check-migration-health.ts", "--json"],
      log,
      exit,
      { databaseUrl: DB_URL, execSyncFn: () => "" }
    );

    expect(code).toBe(0);
    expect(exit).not.toHaveBeenCalled();
    const report = JSON.parse(log.mock.calls[0][0] as string);
    expect(report).toMatchObject({ healthy: true, statusCode: "synced" });
  });

  it("returns 1 and emits a JSON report when the database URL is missing", () => {
    const log = vi.fn();
    const exit = vi.fn();

    const code = runMigrationHealthCli(
      ["node", "check-migration-health.ts", "--json"],
      log,
      exit,
      { databaseUrl: "" }
    );

    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    const report = JSON.parse(log.mock.calls[0][0] as string);
    expect(report).toMatchObject({ healthy: false, statusCode: "missing_database_url" });
  });

  it("returns 1 and reports schema_drift to CI when migrate diff finds differences (#1185)", () => {
    const log = vi.fn();
    const exit = vi.fn();

    const code = runMigrationHealthCli(
      ["node", "check-migration-health.ts", "--json"],
      log,
      exit,
      {
        databaseUrl: DB_URL,
        execSyncFn: (cmd) => {
          if (cmd.includes("prisma migrate diff")) {
            throw Object.assign(new Error("exit code 2"), {
              status: 2,
              stdout: "+model Extra {",
            });
          }
          return "";
        },
      }
    );

    expect(code).toBe(1);
    expect(exit).toHaveBeenCalledWith(1);
    const report = JSON.parse(log.mock.calls[0][0] as string);
    expect(report).toMatchObject({ healthy: false, statusCode: "schema_drift" });
    expect(report.diagnostics.join("\n")).not.toContain("super-secret");
  });

  it("prints the human-readable report by default", () => {
    const log = vi.fn();
    const exit = vi.fn();

    runMigrationHealthCli(["node", "check-migration-health.ts"], log, exit, {
      databaseUrl: "",
    });

    expect(log.mock.calls[0][0]).toContain("MERGEPAY DATABASE MIGRATION HEALTH REPORT");
    expect(log.mock.calls[0][0]).toContain("STATUS: UNHEALTHY (MISSING_DATABASE_URL)");
  });
});
