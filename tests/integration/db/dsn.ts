/**
 * The Postgres connection string the integration suite runs against (#646).
 *
 * Resolved here and shared by `vitest.integration.config.ts` and the global
 * setup/teardown so they can never disagree: if the harness provisioned one
 * database and the tests opened another, every assertion would run against an
 * empty schema and still report green.
 *
 * Precedence matches the config file exactly — `DATABASE_URL_TEST` is the
 * dedicated test database, `DATABASE_URL` is what a local `.env.test` or CI
 * supplies, and the literal default keeps a fresh clone runnable.
 */
export const DEFAULT_TEST_DATABASE_URL =
  "postgresql://postgres:postgres@localhost:5432/mergepay_test";

export function testDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL_TEST ||
    process.env.DATABASE_URL ||
    DEFAULT_TEST_DATABASE_URL
  );
}
