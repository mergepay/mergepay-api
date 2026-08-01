import { buildApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";

async function main() {
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
