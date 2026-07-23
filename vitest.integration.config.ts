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
    env: { NODE_ENV: "test", VITEST: "true" },
    globals: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
