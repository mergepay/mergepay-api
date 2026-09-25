import { defineConfig } from "vitest/config";
import * as dotenv from "dotenv";
import * as path from "path";

// Load test environment variables
const envPath = path.resolve(process.cwd(), ".env.test");
dotenv.config({ path: envPath });

// Ensure test database is used
if (process.env.DATABASE_URL_TEST) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_TEST;
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/integration/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      VITEST: "true",
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/mergepay_test",
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
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
