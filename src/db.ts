import { PrismaClient } from "@prisma/client";
import { env } from "./config";

declare global {
  // eslint-disable-next-line no-var
  var __mergepayPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__mergepayPrisma ??
  new PrismaClient({
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV !== "production") {
  global.__mergepayPrisma = prisma;
}
