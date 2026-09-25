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

const prismaLogLevels = ["query", "info", "warn", "error"] as const;

/**
 * Maps the configured Pino level to the Prisma `log` levels worth emitting.
 * Prisma's own log vocabulary is coarser than Pino's; we surface errors always
 * and progressively add `warn`/`info`/`query` as the Pino level gets more
 * verbose, so the database client's verbosity tracks the rest of the app's
 * logging rather than being a fixed `["error"]` everywhere.
 */
function prismaLogLevelsFor(pinoLevel: string): (typeof prismaLogLevels)[number][] {
  const order: (typeof prismaLogLevels)[number][] = ["error", "warn", "info", "query"];
  const threshold = pinoLevel === "silent" ? -1 : order.indexOf(pinoLevel as (typeof order)[number]);
  // `trace`/`debug` fall through to "query"; unknown levels default to "error".
  const cutoff = threshold < 0 ? 0 : threshold;
  return order.slice(cutoff);
}

/**
 * Builds the Postgres connection string with explicit timeouts tuned for
 * production resilience. Prisma forwards these to the underlying `pg` driver via
 * the connection URL query parameters:
 *   - `connection_limit` caps pooled connections per instance.
 *   - `connect_timeout` bounds socket establishment (a hung DB fails fast).
 *   - `pool_timeout` bounds the wait for a free pooled connection under load.
 * The base `DATABASE_URL` always takes precedence for host/credentials/db.
 */
function buildDatasourceUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const params = url.searchParams;
  params.set("connection_limit", String(env.DATABASE_CONNECTION_LIMIT));
  params.set("connect_timeout", String(env.DATABASE_CONNECT_TIMEOUT_SECONDS));
  params.set("pool_timeout", String(env.DATABASE_POOL_TIMEOUT_SECONDS));
  return url.toString();
}

const basePrisma = new PrismaClient({
  datasources: { db: { url: buildDatasourceUrl(env.DATABASE_URL) } },
  log: prismaLogLevelsFor(env.LOG_LEVEL),
});

basePrisma.$use(queryTimeoutMiddleware(env.DATABASE_QUERY_TIMEOUT_MS));

export const prisma =
  global.__mergepayPrisma ??
  basePrisma;

if (env.NODE_ENV !== "production") {
  global.__mergepayPrisma = prisma;
}

/**
 * Lightweight database ping helper that executes `SELECT 1` with a timeout
 * to verify active PostgreSQL connectivity. Returns `true` on success, or
 * `false` on any failure or timeout instead of throwing uncaught exceptions.
 */
export async function checkDatabaseConnection(
  client: PrismaClient = prisma,
  timeoutMs: number = env.DATABASE_QUERY_TIMEOUT_MS || 5000
): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  try {
    const queryPromise =
      typeof (client as any).$queryRawUnsafe === "function"
        ? (client as any).$queryRawUnsafe("SELECT 1")
        : typeof client.$queryRaw === "function"
          ? client.$queryRaw`SELECT 1`
          : Promise.reject(new Error("No queryRaw method on prisma client"));

    await Promise.race([
      Promise.resolve(queryPromise),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Database health check timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

