/**
 * Provisions the schema and starts each integration run from empty tables (#646).
 *
 * Vitest runs this once, in the main process, before any test file is loaded —
 * so the database exists and is clean by the time the first `app.inject()` is
 * made, and no test file has to care about ordering.
 *
 * `prisma db push` is used rather than `prisma migrate deploy`, matching the
 * repo's own `npm run prisma:deploy`. That is not a preference: the committed
 * migration history cannot be replayed onto a fresh database at all.
 * `prisma/migrations/20260724000000_add_webhooks/migration.sql` creates
 * `"Webhook"`/`"WebhookDelivery"` and adds foreign keys to `"Group"` and
 * `"User"`, while the init migration — and every `@@map` in `schema.prisma` —
 * names those tables `groups`/`users`. A fresh Postgres therefore stops with
 * `42P01: relation "Group" does not exist`. That is reported rather than
 * worked around here; nothing in this harness hand-writes an alternative
 * schema, so `schema.prisma` stays the single source of truth.
 */
import { execFileSync } from "node:child_process";
import { clearIntegrationDatabase } from "./truncate";
import { testDatabaseUrl } from "./dsn";

export default async function setup(): Promise<void> {
  const url = testDatabaseUrl();

  try {
    execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    throw new Error(
      [
        `Integration suite could not prepare the test database (${redact(detail || String(error))}).`,
        "",
        "This suite runs against real Postgres. Start one and point the suite at it, e.g.",
        "  createdb mergepay_test                       # or any server you control",
        "  DATABASE_URL_TEST=postgresql://postgres@localhost:5432/mergepay_test npm run test:integration",
        "CI provisions the same database as a service container (see .github/workflows/ci.yml).",
      ].join("\n")
    );
  }

  const cleared = await clearIntegrationDatabase(url);
  // Emitted once per run, on purpose: the number of tables is the evidence that
  // the harness reached the schema the tests are about to assert against.
  console.log(
    `[integration] test database ready — ${cleared.length} tables provisioned and emptied`
  );
}

/** Keeps credentials out of failure output that ends up in CI logs. */
function redact(message: string): string {
  return message.replace(/postgresql:\/\/[^\s"']+/g, "postgresql://[redacted]");
}
