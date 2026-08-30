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


  const shutdown = async (signal: string) => {
    app.log.info(`Received ${signal}, shutting down…`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));


  try {
    await app.listen({ port: config.PORT, host: "0.0.0.0" });
    app.log.info(`Mergepay API listening on :${config.PORT} (${config.STELLAR_NETWORK})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}


main();
