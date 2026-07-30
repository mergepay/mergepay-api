/**
 * Optional Postgres-backed store for @fastify/rate-limit, so request counts
 * are shared across multiple API instances instead of being tracked
 * per-process. Only used when RATE_LIMIT_STORE=database (see src/config.ts
 * and src/app.ts) — the default is the plugin's built-in in-memory store,
 * which is sufficient for a single instance and adds no per-request query.
 *
 * The plugin instantiates this class itself (`new Store(params)`) and calls
 * `.child(routeParams)` once per route-specific rate-limit config, so a
 * single registration transparently backs every route's counters in the
 * same table, keyed separately.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../db";

interface IncrResult {
  current: number;
  ttl: number;
}

type IncrCallback = (error: Error | null, result?: IncrResult) => void;

const MAX_KEY_LENGTH = 200;

/**
 * @fastify/rate-limit instantiates this with `new Store(globalParams)` and
 * calls `.child(routeParams)` per route; both objects carry a numeric
 * `timeWindow` (in ms) at runtime even though the package's own type
 * declarations under-specify the shape (hence `Record<string, unknown>`).
 */
export class PrismaRateLimitStore {
  private readonly timeWindow: number;

  constructor(params: any) {
    this.timeWindow = typeof params?.timeWindow === "number" ? params.timeWindow : 60_000;
  }

  incr(key: string, callback: IncrCallback): void {
    const boundedKey = String(key).slice(0, MAX_KEY_LENGTH);
    const now = new Date();
    const resetAt = new Date(now.getTime() + this.timeWindow);

    // Single atomic upsert: if the existing window has expired, restart the
    // counter at 1 with a fresh reset time; otherwise increment in place.
    // This is safe under concurrent requests for the same key because the
    // CASE conditions are evaluated against the row Postgres just locked for
    // the UPDATE, not a value read in a separate round trip.
    prisma
      .$queryRaw<{ count: number; reset_at: Date }[]>(
        Prisma.sql`
          INSERT INTO "rate_limit_buckets" ("key", "count", "reset_at", "updated_at")
          VALUES (${boundedKey}, 1, ${resetAt}, ${now})
          ON CONFLICT ("key") DO UPDATE SET
            "count" = CASE
              WHEN "rate_limit_buckets"."reset_at" <= ${now} THEN 1
              ELSE "rate_limit_buckets"."count" + 1
            END,
            "reset_at" = CASE
              WHEN "rate_limit_buckets"."reset_at" <= ${now} THEN ${resetAt}
              ELSE "rate_limit_buckets"."reset_at"
            END,
            "updated_at" = ${now}
          RETURNING "count", "reset_at"
        `
      )
      .then((rows) => {
        const row = rows[0];
        const ttl = Math.max(0, row.reset_at.getTime() - now.getTime());
        callback(null, { current: row.count, ttl });
      })
      .catch((error) => callback(error instanceof Error ? error : new Error(String(error))));
  }

  child(routeParams: any): PrismaRateLimitStore {
    return new PrismaRateLimitStore(routeParams);
  }
}
