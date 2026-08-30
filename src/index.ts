import { buildApp } from "./app";
import { config, env } from "./config";
import { prisma } from "./db";

async function main() {
  // Config validation already happened at module load time in config.ts
  // This explicit check ensures we fail before building the app if config is invalid
  if (!env.DATABASE_URL || !env.API_PUBLIC_URL || !env.JWT_SECRET) {
    console.error("❌ Critical configuration missing. Exiting.");
    process.exit(1);
  }

  const app = await buildApp();

  let shutdownStarted = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;

    const timeoutMs = config.SHUTDOWN_TIMEOUT_MS;
    const timeoutHandle = setTimeout(() => {
      app.log.error({ signal, timeoutMs }, "shutdown timed out, forcing exit");
      process.exit(1);
    }, timeoutMs);

    try {
      app.log.info({ signal, timeoutMs }, "shutting down");
      await app.close();
      await prisma.$disconnect();
      app.log.info({ signal }, "shutdown complete");
    } catch (error) {
      app.log.error({ err: error, signal }, "shutdown failed");
      throw error;
    } finally {
      clearTimeout(timeoutHandle);
      process.exit(0);
    }
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    app.log.info({ port: config.PORT, network: config.STELLAR_NETWORK }, "listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}


main();
