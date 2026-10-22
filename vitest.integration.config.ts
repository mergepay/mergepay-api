import { defineConfig } from "vitest/config";
import * as dotenv from "dotenv";
import * as path from "path";
import { DEFAULT_TEST_DATABASE_URL } from "./tests/integration/db/dsn";

// Load test environment variables. A real .env.test (CI or local secrets)
// wins over the defaults below; otherwise the built-in defaults keep
// src/config.ts validation from exiting before any test runs.
const envPath = path.resolve(process.cwd(), ".env.test");
dotenv.config({ path: envPath });

// Ensure test database is used
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

export default defineConfig({
  test: {
    environment: "node",
    // Integration test suite covers full flows, security, background worker,
    // and API contract alignment (auth, groups, expenses, settlements).
    include: ["tests/integration/**/*.test.ts"],
    exclude: ["**/node_modules/**"],
    // #646 — the schema is provisioned and every table emptied once per run,
    // in the main process, before any file is loaded. The suite therefore
    // starts from a known-empty database instead of inheriting whatever the
    // last run left, and a missing Postgres fails the run rather than
    // skipping it green.
    globalSetup: ["./tests/integration/db/setup.ts"],
    globalTeardown: "./tests/integration/db/teardown.ts",
    env: {
      NODE_ENV: "test",
      VITEST: "true",
      DATABASE_URL: process.env.DATABASE_URL || DEFAULT_TEST_DATABASE_URL,
      API_PUBLIC_URL: "http://localhost:4000",
      JWT_SECRET: "test-secret-key-at-least-16-chars",
      STELLAR_NETWORK: "public",
      HORIZON_URL: "https://horizon.stellar.org",
      ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
      ANCHOR_NAME: "Test Anchor",
      ANCHOR_WEBHOOK_SECRET: "test-webhook-secret",
      STABLE_ASSET_CODE: "USDC",
      STABLE_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    },
    globals: true,
    // The app's client logs every SQL statement it runs, and no `LOG_LEVEL`
    // value turns that off (src/db.ts maps levels onto Prisma's vocabulary by
    // returning the *tail* of the verbosity list, so even `silent` keeps
    // `query`). Against a real database that is thousands of lines per run, so
    // test stdout is muted here. Assertion failures are reported by the runner
    // itself and still print with their diffs.
    silent: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
