import { PrismaClient, Prisma } from "@prisma/client";
import { env } from "./config";

declare global {
  // eslint-disable-next-line no-var
  var __mergepayPrisma: PrismaClient | undefined;
}

/**
 * Creates a Prisma middleware that enforces a maximum execution time for
 * database queries. This prevents hung queries from blocking Fastify request
 * workers indefinitely during network partitions or heavy load.
 */
function queryTimeoutMiddleware(timeoutMs: number): Prisma.Middleware {
  return async (params: Prisma.MiddlewareParams, next: (params: Prisma.MiddlewareParams) => Promise<unknown>) => {
    return Promise.race([
      next(params),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  };
}

const basePrisma = new PrismaClient({
  log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

basePrisma.$use(queryTimeoutMiddleware(env.DATABASE_QUERY_TIMEOUT_MS));

export const prisma =
  global.__mergepayPrisma ??
  basePrisma;

if (env.NODE_ENV !== "production") {
  global.__mergepayPrisma = prisma;
}
