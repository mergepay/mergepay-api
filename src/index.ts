import { buildApp } from "./app";
import { config, env } from "./config";
import { prisma } from "./db";
import { connectWithRetry } from "./lib/db-connect";
import { createGracefulShutdown } from "./lib/graceful-shutdown";

async function main() {
  // Config validation already happened at module load time in config.ts
  // This explicit check ensures we fail before building the app if config is invalid
  if (!env.DATABASE_URL || !env.API_PUBLIC_URL || !env.JWT_SECRET) {
    console.error("❌ Critical configuration missing. Exiting.");
    process.exit(1);
  }

  const app = await buildApp();

  // Wait for the database before accepting traffic, so a container that
  // starts ahead of PostgreSQL doesn't serve failing requests or crash-loop.
  try {
    await connectWithRetry(prisma, { logger: app.log });
  } catch {
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
