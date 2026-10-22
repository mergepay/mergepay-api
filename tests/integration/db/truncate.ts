/**
 * Empties every table in the integration database (#646).
 *
 * The list is read from `pg_tables` rather than written out by hand, so a new
 * model needs no change here — a hardcoded list would silently stop clearing
 * the new table, and the next run would inherit rows from the last one and
 * assert against data it never created.
 *
 * `TRUNCATE ... CASCADE` is used per table because the foreign keys between
 * these tables are real (that is the point of running against Postgres rather
 * than a mocked client) and a plain TRUNCATE refuses wherever a dependent row
 * exists. `_prisma_migrations` is left alone: it is harness bookkeeping, not
 * application state.
 */
import { PrismaClient } from "@prisma/client";

/** Postgres identifiers are folded to lower case; quoting preserves them exactly. */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function clearIntegrationDatabase(url: string): Promise<string[]> {
  const prisma = new PrismaClient({
    datasources: { db: { url } },
    log: ["error"],
  });

  try {
    const tables = await prisma.$queryRawUnsafe<{ tablename: string }[]>(
      `SELECT tablename
         FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename <> '_prisma_migrations'
        ORDER BY tablename`
    );

    for (const { tablename } of tables) {
      await prisma.$executeRawUnsafe(
        `TRUNCATE TABLE ${quoteIdent(tablename)} RESTART IDENTITY CASCADE`
      );
    }

    return tables.map((t) => t.tablename);
  } finally {
    await prisma.$disconnect();
  }
}
