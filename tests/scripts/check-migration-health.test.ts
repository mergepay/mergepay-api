import { describe, it, expect } from "vitest";
import {
  checkMigrationHealth,
  parseConnectionError,
  formatHealthReport,
} from "../../scripts/check-migration-health";

describe("Database Migration Health Check Script (#806)", () => {
  describe("parseConnectionError", () => {
    it("identifies P1001 unreachable database server errors", () => {
      const err = "Error: P1001: Can't reach database server at `localhost`:`5432`";
      const parsed = parseConnectionError(err);
      expect(parsed).toContain("Database server unreachable");
      expect(parsed).toContain("Verify database host, port");
    });

    it("identifies P1002 connection timeout errors", () => {
      const err = "Error: P1002: The database server was reached but timed out";
      const parsed = parseConnectionError(err);
      expect(parsed).toContain("Database connection timed out");
    });

    it("identifies P1003 missing database errors", () => {
      const err = "Error: P1003: Database `mergepay_prod` does not exist on the database server";
      const parsed = parseConnectionError(err);
      expect(parsed).toContain("Target database does not exist");
    });

    it("identifies P1017 closed connection errors", () => {
      const err = "Error: P1017: Server closed the connection";
      const parsed = parseConnectionError(err);
      expect(parsed).toContain("unexpectedly closed connection");
    });

    it("identifies authentication failure errors", () => {
      const err = "Error: password authentication failed for user 'postgres'";
      const parsed = parseConnectionError(err);
      expect(parsed).toContain("Database authentication failed");
    });

    it("falls back gracefully for unknown errors", () => {
      const err = "Some unexpected socket anomaly";
      const parsed = parseConnectionError(err);
      expect(parsed).toContain("Could not establish connection");
    });
  });

  describe("checkMigrationHealth", () => {
    it("reports missing_database_url when DATABASE_URL is empty", () => {
      const result = checkMigrationHealth({ databaseUrl: "" });
      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("missing_database_url");
      expect(result.diagnostics).toContain("❌ DATABASE_URL environment variable is not defined");
    });

    it("reports schema_invalid when prisma validate throws", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma validate")) {
          throw new Error("Syntax error in schema.prisma on line 42");
        }
        return "ok";
      };

      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });

      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("schema_invalid");
      expect(result.diagnostics.some((d) => d.includes("Prisma schema validation failed"))).toBe(true);
    });

    it("reports synced when database migrations are up to date", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma validate")) return "Schema is valid";
        if (cmd.includes("prisma migrate status")) return "Database schema is up to date!";
        return "";
      };

      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });

      expect(result.healthy).toBe(true);
      expect(result.statusCode).toBe("synced");
      expect(result.diagnostics.some((d) => d.includes("Database schema is up to date"))).toBe(true);
    });

    it("reports pending_migrations when unapplied migrations exist", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma validate")) return "Schema is valid";
        if (cmd.includes("prisma migrate status")) {
          return "Following migration have not yet been applied: 20261024_add_index. 1 migration have not yet been applied.";
        }
        return "";
      };

      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });

      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("pending_migrations");
      expect(result.pendingMigrationsCount).toBe(1);
      expect(result.diagnostics.some((d) => d.includes("pending unapplied migrations"))).toBe(true);
    });

    it("reports pending_migrations when `migrate status` exits non-zero with pending output (#1081)", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma migrate status")) {
          throw Object.assign(new Error("Command failed"), {
            stdout: "2 migrations have not yet been applied: a, b",
          });
        }
        return "";
      };
      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });
      expect(result.statusCode).toBe("pending_migrations");
      expect(result.pendingMigrationsCount).toBe(2);
    });

    it("reports failed_migration when a migration failed to apply (#1081)", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma migrate status")) {
          throw Object.assign(new Error("Command failed"), {
            stdout: "Following migration have failed to apply: 20261024_x",
          });
        }
        return "";
      };
      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });
      expect(result.statusCode).toBe("failed_migration");
      expect(result.healthy).toBe(false);
    });

    it("reports schema_drift when migrate diff finds differences (#1081)", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma migrate diff")) {
          throw Object.assign(new Error("exit code 2"), { status: 2, stdout: "-- drift" });
        }
        return "";
      };
      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });
      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("schema_drift");
    });

    it("includes redacted drift statements for CI diagnostics (#1185)", () => {
      const dbUrl = "postgresql://migration_user:super-secret@db.internal:5432/mergepay";
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma migrate diff")) {
          throw Object.assign(new Error(`Command failed for ${dbUrl}`), {
            status: 2,
            stdout: [
              "--- a/prisma/schema.prisma",
              "+++ b/prisma/schema.prisma",
              "+model Extra {",
              "+  id String @id",
              "+}",
              `-database: ${dbUrl}`,
            ].join("\n"),
          });
        }
        return "";
      };

      const result = checkMigrationHealth({ databaseUrl: dbUrl, execSyncFn: mockRunner });

      expect(result.statusCode).toBe("schema_drift");
      expect(result.diagnostics).toContain("ℹ️ Differing schema statements (redacted):");
      expect(result.diagnostics.some((line) => line.includes("+model Extra {"))).toBe(true);
      // File headers carry no information about what drifted.
      expect(result.diagnostics.some((line) => line.trim().startsWith("+++"))).toBe(false);

      const joined = result.diagnostics.join("\n");
      expect(joined).not.toContain("super-secret");
      expect(joined).not.toContain(dbUrl);
      expect(joined).not.toContain("db.internal");
    });

    it("stays healthy when migrations are applied and there is no drift (#1081)", () => {
      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: () => "",
      });
      expect(result.statusCode).toBe("synced");
      expect(result.diagnostics.some((d) => d.includes("No drift"))).toBe(true);
    });

    it("reports connection_error with descriptive message when connection fails", () => {
      const mockRunner = (cmd: string) => {
        if (cmd.includes("prisma validate")) return "Schema is valid";
        if (cmd.includes("prisma migrate status")) {
          throw new Error("P1001: Can't reach database server at `db.internal`:5432");
        }
        return "";
      };

      const result = checkMigrationHealth({
        databaseUrl: "postgresql://localhost:5432/test",
        execSyncFn: mockRunner,
      });

      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("connection_error");
      expect(result.message).toContain("Database server unreachable");
    });
  });

  describe("formatHealthReport", () => {
    it("formats healthy report correctly", () => {
      const formatted = formatHealthReport({
        healthy: true,
        statusCode: "synced",
        message: "Optimal migration health",
        diagnostics: ["✅ Schema verified", "✅ Migrations up to date"],
      });

      expect(formatted).toContain("MERGEPAY DATABASE MIGRATION HEALTH REPORT");
      expect(formatted).toContain("STATUS: HEALTHY (SYNCED)");
      expect(formatted).toContain("Optimal migration health");
      expect(formatted).toContain("✅ Schema verified");
    });

    it("formats unhealthy report correctly", () => {
      const formatted = formatHealthReport({
        healthy: false,
        statusCode: "connection_error",
        message: "Server unreachable",
        diagnostics: ["❌ Connection failed"],
      });

      expect(formatted).toContain("STATUS: UNHEALTHY (CONNECTION_ERROR)");
      expect(formatted).toContain("REASON: Server unreachable");
    });
  });
});
