import { buildApp } from "./app";
import { config, env } from "./config";
import { prisma } from "./db";
import { connectWithRetry } from "./lib/db-connect";
import { createGracefulShutdown } from "./lib/graceful-shutdown";
import { runStartupMigrationCheck } from "./lib/startup-migration-check";
import { preloadSep10SigningKey } from "./services/auth-health";

async function main() {
  // Config validation already happened at module load time in config.ts
  // This explicit check ensures we fail before building the app if config is invalid
  if (!env.DATABASE_URL || !env.API_PUBLIC_URL || !env.JWT_SECRET) {
    console.error("❌ Critical configuration missing. Exiting.");
    process.exit(1);
  }

  // Derive the SEP-10 signing key once, before the app accepts traffic: a
  // malformed SEP10_SIGNING_SECRET fails the boot instead of the first login,
  // and every challenge/verification reuses the memoized keypair (issue #1033).
  // The public key is not secret — it is published in stellar.toml.
  const sep10ServerPublicKey = preloadSep10SigningKey();

  const app = await buildApp();
  app.log.info({ sep10ServerPublicKey }, "SEP-10 signing key loaded");

  // Wait for the database before accepting traffic, so a container that
  // starts ahead of PostgreSQL doesn't serve failing requests or crash-loop.
  try {
    await connectWithRetry(prisma, { logger: app.log });
  } catch {
    await app.close();
    process.exit(1);
  }

  // Verify migration health after the connection is live but before the port
  // opens. A pending or drifted schema causes process.exit(1) so a bad deploy
  // is caught here rather than during the first request (#1140).
  try {
    await runStartupMigrationCheck({ databaseUrl: env.DATABASE_URL, logger: app.log });
  } catch (err) {
    app.log.error({ err }, "startup migration check failed; exiting");
    await app.close();
    process.exit(1);
  }

  createGracefulShutdown({
    logger: app.log,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    close: async (signal) => {
      try {
        await app.close();
      } finally {
        await prisma.$disconnect();
        app.log.info({ signal }, "database disconnected");
      }
    },
  });

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    app.log.info({ port: config.PORT, network: config.STELLAR_NETWORK }, "listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}


main();
