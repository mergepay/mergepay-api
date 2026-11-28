/**
 * CLI compatibility entry point for the migration health check.
 *
 * The implementation lives under src/lib so application code can use it
 * without importing outside tsconfig.json's rootDir. Keep this path stable
 * for the existing npm scripts and test imports.
 */

export * from "../src/lib/migration-health";

import { runMigrationHealthCli } from "../src/lib/migration-health";

if (typeof require !== "undefined" && require.main === module) {
  runMigrationHealthCli(process.argv);
}
