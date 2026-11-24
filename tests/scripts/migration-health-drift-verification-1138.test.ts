/**
 * Migration health check and drift verification unit tests (#1138).
 *
 * Covers `checkMigrationHealth`, `runMigrationHealthCli`, `formatHealthReport`,
 * `redactSecrets`, and `extractDriftSql` from scripts/check-migration-health.ts
 * with deterministic mocked command runners — no database, no Prisma CLI, no
 * network required. Guards against regressions in schema drift detection logic.
 */
import { describe, it, expect, vi } from "vitest";
import {
  checkMigrationHealth,
  runMigrationHealthCli,
  formatHealthReport,
  redactSecrets,
  extractDriftSql,
  summarizeDriftDiagnostics,
  parseConnectionError,
  type CommandRunner,
  type MigrationHealthStatus,
} from "../../scripts/check-migration-health";

const DB_URL = "postgresql://user:s3cr3t@db.internal:5432/mergepay";

// ── Runner factories ──────────────────────────────────────────────────────────

/** All Prisma commands succeed; no pending migrations, no drift. */
function cleanRunner(): CommandRunner {
  return () => "Database schema is up-to-date!";
}

/** `prisma validate` fails (bad schema). */
function invalidSchemaRunner(): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma validate")) {
      throw new Error("Syntax error on line 42: unexpected token");
    }
    return "";
  };
}

/** `prisma migrate status` exits non-zero with pending migration output. */
function pendingMigrationsRunner(count = 2): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma migrate status")) {
      throw Object.assign(
        new Error(
          `Command failed: prisma migrate status\n${count} migrations have not yet been applied`
        ),
        { status: 1, stderr: `${count} migrations have not yet been applied` }
      );
    }
    return "";
  };
}

/** `prisma migrate status` indicates a failed migration. */
function failedMigrationRunner(): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma migrate status")) {
      throw Object.assign(
        new Error(
          "Command failed: prisma migrate status\nMigration 20240501_add_index was started but could not be completed"
        ),
        { status: 1 }
      );
    }
    return "";
  };
}

/** `prisma migrate diff` exits with code 2 indicating drift. */
function driftRunner(sql: string): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma migrate diff")) {
      throw Object.assign(new Error("Command failed"), {
        status: 2,
        stdout: sql,
      });
    }
    return "";
  };
}

/** `prisma migrate diff` exits with code 3 (broken invocation, not drift). */
function brokenDiffRunner(): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma migrate diff")) {
      throw Object.assign(
        new Error("Command failed: unknown flag --from-schema-datasource"),
        { status: 3 }
      );
    }
    return "";
  };
}

/** `prisma migrate status` fails with a connection error (P1001). */
function connectionErrorRunner(): CommandRunner {
  return (cmd) => {
    if (cmd.includes("prisma migrate status")) {
      throw new Error(
        "P1001: Can't reach database server at `db.internal`:`5432`"
      );
    }
    return "";
  };
}

// ── missing DATABASE_URL ──────────────────────────────────────────────────────

describe("checkMigrationHealth — missing_database_url (#1138)", () => {
  it("returns unhealthy with missing_database_url when databaseUrl is undefined and env unset", () => {
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      const result = checkMigrationHealth({ databaseUrl: undefined });
      expect(result.healthy).toBe(false);
      expect(result.statusCode).toBe("missing_database_url");
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });

  it("returns unhealthy with missing_database_url when databaseUrl is empty string", () => {
    const result = checkMigrationHealth({ databaseUrl: "" });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("missing_database_url");
  });

  it("includes a remediation step pointing to DATABASE_URL setup", () => {
    const result = checkMigrationHealth({ databaseUrl: "" });
    expect(result.remediation).toBeDefined();
    expect(result.remediation!.some((s) => /DATABASE_URL/i.test(s))).toBe(true);
  });
});

// ── schema_invalid ────────────────────────────────────────────────────────────

describe("checkMigrationHealth — schema_invalid (#1138)", () => {
  it("returns unhealthy with schema_invalid when prisma validate throws", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: invalidSchemaRunner(),
    });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("schema_invalid");
  });

  it("includes a diagnostic mentioning schema validation failure", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: invalidSchemaRunner(),
    });
    expect(result.diagnostics.some((d) => /schema.*validat/i.test(d))).toBe(true);
  });

  it("includes a remediation step advising `npx prisma validate`", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: invalidSchemaRunner(),
    });
    expect(result.remediation!.some((s) => /prisma validate/i.test(s))).toBe(true);
  });
});

// ── pending_migrations ────────────────────────────────────────────────────────

describe("checkMigrationHealth — pending_migrations (#1138)", () => {
  it("returns unhealthy with pending_migrations statusCode", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: pendingMigrationsRunner(3),
    });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("pending_migrations");
  });

  it("extracts the pending migration count from the error output", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: pendingMigrationsRunner(3),
    });
    expect(result.pendingMigrationsCount).toBe(3);
  });

  it("includes a remediation step advising `prisma migrate deploy`", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: pendingMigrationsRunner(),
    });
    expect(result.remediation!.some((s) => /prisma migrate deploy/i.test(s))).toBe(true);
  });
});

// ── failed_migration ──────────────────────────────────────────────────────────

describe("checkMigrationHealth — failed_migration (#1138)", () => {
  it("returns unhealthy with failed_migration statusCode", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: failedMigrationRunner(),
    });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("failed_migration");
  });

  it("includes remediation for prisma migrate resolve", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: failedMigrationRunner(),
    });
    expect(result.remediation!.some((s) => /prisma migrate resolve/i.test(s))).toBe(true);
  });
});

// ── schema_drift detection ────────────────────────────────────────────────────

describe("checkMigrationHealth — schema_drift (#1138)", () => {
  const DRIFT_SQL = [
    'ALTER TABLE "User" ADD COLUMN "displayName" TEXT;',
    'CREATE INDEX "User_displayName_idx" ON "User"("displayName");',
  ].join("\n");

  it("returns unhealthy with schema_drift statusCode when exit code is 2", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: driftRunner(DRIFT_SQL),
    });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("schema_drift");
  });

  it("includes a diagnostic describing the drift", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: driftRunner(DRIFT_SQL),
    });
    expect(
      result.diagnostics.some((d) => /drift detected/i.test(d))
    ).toBe(true);
  });

  it("includes SQL statements from the diff output in diagnostics", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: driftRunner(DRIFT_SQL),
    });
    const joined = result.diagnostics.join("\n");
    expect(joined).toContain("displayName");
  });

  it("includes remediation advising to generate a new migration", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: driftRunner(DRIFT_SQL),
    });
    expect(result.remediation!.some((s) => /prisma migrate dev/i.test(s))).toBe(true);
  });

  it("distinguishes drift (exit 2) from broken invocation (exit 3)", () => {
    const driftResult = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: driftRunner(DRIFT_SQL),
    });
    const brokenResult = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: brokenDiffRunner(),
    });
    expect(driftResult.statusCode).toBe("schema_drift");
    expect(brokenResult.statusCode).toBe("drift_check_error");
  });
});

// ── drift_check_error ─────────────────────────────────────────────────────────

describe("checkMigrationHealth — drift_check_error (#1138)", () => {
  it("reports drift_check_error when diff exits with a code other than 2", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: brokenDiffRunner(),
    });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("drift_check_error");
  });

  it("includes remediation advising to run the diff command manually", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: brokenDiffRunner(),
    });
    expect(result.remediation!.some((s) => /prisma migrate diff/i.test(s))).toBe(true);
  });
});

// ── connection_error ──────────────────────────────────────────────────────────

describe("checkMigrationHealth — connection_error (#1138)", () => {
  it("returns unhealthy with connection_error on P1001", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: connectionErrorRunner(),
    });
    expect(result.healthy).toBe(false);
    expect(result.statusCode).toBe("connection_error");
  });

  it("includes remediation for checking database connectivity", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: connectionErrorRunner(),
    });
    expect(result.remediation!.some((s) => /DATABASE_URL|database server/i.test(s))).toBe(true);
  });
});

// ── synced (healthy) ──────────────────────────────────────────────────────────

describe("checkMigrationHealth — synced/healthy (#1138)", () => {
  it("returns healthy with synced statusCode on clean migration state", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: cleanRunner(),
    });
    expect(result.healthy).toBe(true);
    expect(result.statusCode).toBe("synced");
  });

  it("includes a diagnostic confirming no drift", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: cleanRunner(),
    });
    expect(result.diagnostics.some((d) => /no drift|up to date/i.test(d))).toBe(true);
  });

  it("includes an empty remediation array", () => {
    const result = checkMigrationHealth({
      databaseUrl: DB_URL,
      execSyncFn: cleanRunner(),
    });
    expect(result.remediation).toEqual([]);
  });
});

// ── redactSecrets ─────────────────────────────────────────────────────────────

describe("redactSecrets (#1138)", () => {
  it("replaces the full DATABASE_URL with <DATABASE_URL>", () => {
    const text = `Connected to ${DB_URL} successfully`;
    expect(redactSecrets(text, DB_URL)).not.toContain(DB_URL);
    expect(redactSecrets(text, DB_URL)).toContain("<DATABASE_URL>");
  });

  it("replaces the password in the URL with ***", () => {
    const text = `Connection string: ${DB_URL}`;
    const redacted = redactSecrets(text, DB_URL);
    expect(redacted).not.toContain("s3cr3t");
  });

  it("masks postgres:// credentials even without a known DB_URL", () => {
    const text = "Error: postgres://admin:hunter2@localhost/db not reachable";
    const redacted = redactSecrets(text);
    expect(redacted).not.toContain("hunter2");
  });

  it("is a no-op on text with no credentials", () => {
    const text = "All migrations applied successfully";
    expect(redactSecrets(text, DB_URL)).toBe(text);
  });
});

// ── extractDriftSql ───────────────────────────────────────────────────────────

describe("extractDriftSql (#1138)", () => {
  it("returns SQL statements from drift output", () => {
    const raw = [
      "Prisma schema loaded from prisma/schema.prisma",
      'ALTER TABLE "User" ADD COLUMN "bio" TEXT;',
      'CREATE INDEX "User_bio_idx" ON "User"("bio");',
    ].join("\n");

    const lines = extractDriftSql(raw, DB_URL);
    expect(lines).toContain('ALTER TABLE "User" ADD COLUMN "bio" TEXT;');
    expect(lines).toContain('CREATE INDEX "User_bio_idx" ON "User"("bio");');
  });

  it("caps the preview at DRIFT_PREVIEW_LINES (12)", () => {
    const raw = Array.from({ length: 20 }, (_, i) =>
      `ALTER TABLE "T${i}" ADD COLUMN "c${i}" TEXT;`
    ).join("\n");

    const lines = extractDriftSql(raw, DB_URL);
    expect(lines.length).toBeLessThanOrEqual(12);
  });

  it("redacts credentials from the diff output", () => {
    const raw = `Connected to ${DB_URL}\nALTER TABLE "X" ADD COLUMN "y" TEXT;`;
    const lines = extractDriftSql(raw, DB_URL);
    expect(lines.join("\n")).not.toContain(DB_URL);
  });

  it("filters out diff file headers (+++ / ---)", () => {
    const raw = [
      "+++ b/prisma/schema.prisma",
      "--- a/prisma/schema.prisma",
      'ALTER TABLE "X" ADD COLUMN "y" TEXT;',
    ].join("\n");

    const lines = extractDriftSql(raw);
    expect(lines.every((l) => !/^\+\+\+|^---/.test(l))).toBe(true);
  });
});

// ── summarizeDriftDiagnostics ─────────────────────────────────────────────────

describe("summarizeDriftDiagnostics (#1138)", () => {
  it("returns +/- lines from diff output up to maxLines", () => {
    const raw = [
      "+  bio    String?",
      "-  bio    String",
      "   unchanged String",
    ].join("\n");

    const lines = summarizeDriftDiagnostics(raw, DB_URL, 5);
    expect(lines.some((l) => /bio/.test(l))).toBe(true);
    expect(lines.length).toBeLessThanOrEqual(5);
  });

  it("omits context lines (lines not starting with + or -)", () => {
    const raw = [
      "  unchanged",
      "+ added_field String",
      "  another_unchanged",
    ].join("\n");

    const lines = summarizeDriftDiagnostics(raw, DB_URL);
    expect(lines.every((l) => /^[+-]/.test(l))).toBe(true);
  });
});

// ── formatHealthReport ────────────────────────────────────────────────────────

describe("formatHealthReport (#1138)", () => {
  it("includes STATUS: HEALTHY for a synced result", () => {
    const status: MigrationHealthStatus = {
      healthy: true,
      statusCode: "synced",
      message: "All good",
      diagnostics: ["✅ Migrations up to date"],
      remediation: [],
    };
    const report = formatHealthReport(status);
    expect(report).toContain("STATUS: HEALTHY");
    expect(report).toContain("SYNCED");
  });

  it("includes STATUS: UNHEALTHY and NEXT STEPS for an unhealthy result", () => {
    const status: MigrationHealthStatus = {
      healthy: false,
      statusCode: "pending_migrations",
      message: "Pending migrations found",
      diagnostics: ["⚠️ Pending"],
      remediation: ["Run prisma migrate deploy"],
    };
    const report = formatHealthReport(status);
    expect(report).toContain("STATUS: UNHEALTHY");
    expect(report).toContain("NEXT STEPS");
    expect(report).toContain("prisma migrate deploy");
  });
});

// ── runMigrationHealthCli — JSON flag ─────────────────────────────────────────

describe("runMigrationHealthCli — JSON output flag (#1138)", () => {
  it("prints JSON when --json flag is passed", () => {
    const logs: string[] = [];
    const exits: number[] = [];

    runMigrationHealthCli(
      ["--json"],
      (msg) => logs.push(msg),
      (code) => exits.push(code),
      { databaseUrl: DB_URL, execSyncFn: cleanRunner() }
    );

    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[0]);
    expect(parsed).toHaveProperty("healthy");
    expect(parsed).toHaveProperty("statusCode");
  });

  it("returns exit code 0 for a healthy database", () => {
    const code = runMigrationHealthCli(
      [],
      () => {},
      () => {},
      { databaseUrl: DB_URL, execSyncFn: cleanRunner() }
    );
    expect(code).toBe(0);
  });

  it("calls exit with 1 and returns 1 for an unhealthy result", () => {
    const exits: number[] = [];
    const code = runMigrationHealthCli(
      [],
      () => {},
      (c) => exits.push(c),
      { databaseUrl: "", execSyncFn: cleanRunner() }
    );
    expect(code).toBe(1);
    expect(exits).toContain(1);
  });
});

// ── parseConnectionError ──────────────────────────────────────────────────────

describe("parseConnectionError — drift error classification (#1138)", () => {
  it("classifies P1001 as server unreachable", () => {
    expect(parseConnectionError("P1001: unreachable")).toContain("unreachable");
  });

  it("classifies P1002 as timeout", () => {
    expect(parseConnectionError("P1002: timed out")).toContain("timed out");
  });

  it("classifies P1003 as missing database", () => {
    expect(parseConnectionError("database does not exist")).toContain("does not exist");
  });

  it("classifies P1017 as closed connection", () => {
    expect(parseConnectionError("P1017: server closed the connection")).toContain("unexpectedly closed");
  });

  it("classifies authentication failure", () => {
    expect(parseConnectionError("password authentication failed")).toContain("authentication failed");
  });

  it("falls back gracefully for unknown errors", () => {
    expect(parseConnectionError("some unknown socket error")).toContain("Could not establish connection");
  });
});
