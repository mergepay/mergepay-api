import { describe, it, expect, vi } from "vitest";
import {
  checkMigrationHealth,
  extractDriftSql,
  redactSecrets,
  formatHealthReport,
  runMigrationHealthCli,
  type CommandRunner,
} from "../../scripts/check-migration-health";

const DB_URL = "postgresql://migration_user:super-secret@db.internal:5432/mergepay";

/** Runner where `prisma migrate diff` reports drift with exit code 2. */
function driftRunner(sql: string): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma migrate diff")) {
      throw Object.assign(new Error("Command failed: prisma migrate diff"), {
        status: 2,
        stdout: sql,
      });
    }
    return "";
  };
}

describe("migration health drift diagnostics (#1118)", () => {
  describe("actionable drift report", () => {
    it("includes the reconciliation SQL when drift is detected", () => {
      const sql = [
        "Prisma schema loaded from prisma/schema.prisma",
        "Datasource \"db\"",
        "ALTER TABLE \"Expense\" ADD COLUMN \"note\" TEXT;",
        "CREATE INDEX \"Expense_groupId_idx\" ON \"Expense\"(\"groupId\");",
      ].join("\n");

      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: driftRunner(sql),
      });

      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("schema_drift");
      expect(result.diagnostics).toContain(
        "❌ Schema drift detected between the database and prisma/schema.prisma"
      );
      expect(result.diagnostics.join("\n")).toContain(
        'ALTER TABLE "Expense" ADD COLUMN "note" TEXT;'
      );
      expect(result.diagnostics.join("\n")).toContain(
        'CREATE INDEX "Expense_groupId_idx" ON "Expense"("groupId");'
      );
    });

    it("tells the operator how to generate and inspect the reconciling migration", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: driftRunner("ALTER TABLE \"A\" ADD COLUMN \"b\" TEXT;"),
      });

      const remediation = result.remediation ?? [];
      expect(remediation.length).toBeGreaterThan(0);
      expect(remediation.join("\n")).toContain("npx prisma migrate dev --name");
      expect(remediation.join("\n")).toContain("npx prisma migrate diff");
      expect(remediation.join("\n")).toContain("--script");
    });

    it("renders next steps in the human-readable report", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: driftRunner("ALTER TABLE \"A\" ADD COLUMN \"b\" TEXT;"),
      });

      const report = formatHealthReport(result);
      expect(report).toContain("STATUS: UNHEALTHY (SCHEMA_DRIFT)");
      expect(report).toContain("NEXT STEPS:");
      expect(report).toContain("npx prisma migrate dev --name");
    });

    it("redacts database credentials from the drift preview", () => {
      const sql = `-- drift against ${DB_URL}\nALTER TABLE "A" ADD COLUMN "b" TEXT;`;

      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: driftRunner(sql),
      });

      const output = result.diagnostics.join("\n");
      expect(output).not.toContain("super-secret");
      expect(output).not.toContain("migration_user:super-secret");
      expect(output).toContain("ALTER TABLE");
    });
  });

  describe("drift check failures are not reported as drift", () => {
    it("classifies a non-2 exit status as drift_check_error with remediation", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: (cmd) => {
          if (cmd.includes("prisma migrate diff")) {
            throw Object.assign(new Error("unknown flag `--from-schema-datasource`"), {
              status: 1,
            });
          }
          return "";
        },
      });

      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("drift_check_error");
      expect(result.diagnostics.join("\n")).toContain("exited with code 1");
      expect(result.message).toContain("failed to run");
      expect((result.remediation ?? []).join("\n")).toContain("npx prisma --version");
    });

    it("still treats a connection failure during the diff as a connection error", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: (cmd) => {
          if (cmd.includes("prisma migrate diff")) {
            throw Object.assign(new Error("P1001: can't reach database server"), { status: 1 });
          }
          return "";
        },
      });

      expect(result.statusCode).toBe("connection_error");
      expect(result.message).toContain("Database server unreachable");
    });

    it("falls back to drift when the runner exposes no exit status", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: (cmd) => {
          if (cmd.includes("prisma migrate diff")) throw new Error("diff exists");
          return "";
        },
      });

      expect(result.statusCode).toBe("schema_drift");
    });
  });

  describe("other statuses carry remediation", () => {
    it("pending migrations point at `prisma migrate deploy`", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: (cmd) =>
          cmd.includes("prisma migrate status")
            ? "2 migrations have not yet been applied: a, b"
            : "",
      });

      expect(result.statusCode).toBe("pending_migrations");
      expect((result.remediation ?? []).join("\n")).toContain("npx prisma migrate deploy");
    });

    it("detects a failed migration even when `migrate status` succeeds", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: (cmd) =>
          cmd.includes("prisma migrate status")
            ? "Following migration have failed to apply: 20261024_x"
            : "",
      });

      expect(result.statusCode).toBe("failed_migration");
      expect((result.remediation ?? []).join("\n")).toContain("npx prisma migrate resolve --rolled-back");
    });

    it("explains how to supply a missing DATABASE_URL", () => {
      const result = checkMigrationHealth({ databaseUrl: "" });

      expect(result.statusCode).toBe("missing_database_url");
      expect((result.remediation ?? []).join("\n")).toContain("DATABASE_URL");
      expect(formatHealthReport(result)).toContain("NEXT STEPS:");
    });

    it("omits next steps for a healthy database", () => {
      const result = checkMigrationHealth({
        databaseUrl: DB_URL,
        execSyncFn: () => "",
      });

      expect(result.healthy).toBe(true);
      expect(result.remediation).toEqual([]);
      expect(formatHealthReport(result)).not.toContain("NEXT STEPS:");
    });
  });

  describe("CLI contract", () => {
    it("exits 1 and emits remediation in the JSON report for drift", () => {
      const log = vi.fn();
      const exit = vi.fn();

      const code = runMigrationHealthCli(
        ["node", "check-migration-health.ts", "--json"],
        log,
        exit,
        { databaseUrl: DB_URL, execSyncFn: driftRunner("ALTER TABLE \"A\" ADD COLUMN \"b\" TEXT;") }
      );

      expect(code).toBe(1);
      expect(exit).toHaveBeenCalledWith(1);
      const report = JSON.parse(log.mock.calls[0][0] as string);
      expect(report.statusCode).toBe("schema_drift");
      expect(report.remediation.length).toBeGreaterThan(0);
    });
  });

  describe("helpers", () => {
    it("redacts any postgres URL credentials, even from unrelated URLs", () => {
      const text =
        "error: postgresql://someone:another-secret@localhost:5432/mergepay and postgres://u:p@h/db";
      const redacted = redactSecrets(text);

      expect(redacted).not.toContain("another-secret");
      expect(redacted).not.toContain(":p@");
      expect(redacted).toContain("postgresql://someone:***@localhost:5432/mergepay");
    });

    it("caps the drift preview and ignores Prisma boilerplate", () => {
      const sql = [
        "Prisma schema loaded from prisma/schema.prisma",
        ...Array.from({ length: 20 }, (_, i) => `ALTER TABLE "T${i}" ADD COLUMN "c" TEXT;`),
      ].join("\n");

      const preview = extractDriftSql(sql);

      expect(preview).toHaveLength(12);
      expect(preview[0]).toBe('ALTER TABLE "T0" ADD COLUMN "c" TEXT;');
      expect(preview.join("\n")).not.toContain("Prisma schema loaded");
    });

    it("returns an empty preview when the diff output has no SQL", () => {
      expect(extractDriftSql("Error: unknown flag")).toEqual([]);
    });
  });
});
