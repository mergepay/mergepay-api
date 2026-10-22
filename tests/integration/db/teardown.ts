/**
 * Leaves the integration database empty after a run (#646).
 *
 * Cleanup belongs to the harness rather than to each test file: a file that
 * fails half-way through its workflow would otherwise leave a group behind,
 * and the next run's assertions — which count rows, not rows it created —
 * would read that leftover as this run's output.
 */
import { clearIntegrationDatabase } from "./truncate";
import { testDatabaseUrl } from "./dsn";

export default async function teardown(): Promise<void> {
  await clearIntegrationDatabase(testDatabaseUrl());
}
