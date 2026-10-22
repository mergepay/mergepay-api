/**
 * Tests for the explicit connection/query timeout configuration applied to the
 * Prisma client in `src/db.ts`:
 *
 *  - `buildDatasourceUrl` — appends `connection_limit`, `connect_timeout`, and
 *    `pool_timeout` to `DATABASE_URL` so a slow or partitioned database fails
 *    fast instead of hanging request workers.
 *  - `queryTimeoutMiddleware` — bounds every Prisma query's wall-clock time and
 *    clears its race timer when the query settles.
 *
 * No database or network is touched: the config module is mocked and the
 * PrismaClient constructed at import time never connects lazily.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Prisma } from "@prisma/client";

vi.mock("../src/config", () => ({
  env: {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    DATABASE_URL: "postgresql://postgres:secret@db.example:5432/mergepay",
    DATABASE_CONNECTION_LIMIT: 5,
    DATABASE_CONNECT_TIMEOUT_SECONDS: 10,
    DATABASE_POOL_TIMEOUT_SECONDS: 10,
    DATABASE_QUERY_TIMEOUT_MS: 10000,
  },
}));

import { buildDatasourceUrl, queryTimeoutMiddleware } from "../src/db";

function params(): Prisma.MiddlewareParams {
  return {} as Prisma.MiddlewareParams;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("buildDatasourceUrl", () => {
  it("appends connection_limit, connect_timeout, and pool_timeout to DATABASE_URL", () => {
    const url = new URL(buildDatasourceUrl("postgresql://postgres:secret@db.example:5432/mergepay"));

    expect(url.searchParams.get("connection_limit")).toBe("5");
    expect(url.searchParams.get("connect_timeout")).toBe("10");
    expect(url.searchParams.get("pool_timeout")).toBe("10");
  });

  it("preserves the host, credentials, database name, and any pre-existing parameters", () => {
    const url = new URL(
      buildDatasourceUrl(
        "postgresql://postgres:secret@db.example:5432/mergepay?sslmode=require&schema=public"
      )
    );

    expect(url.host).toBe("db.example:5432");
    expect(url.username).toBe("postgres");
    expect(url.password).toBe("secret");
    expect(url.pathname).toBe("/mergepay");
    expect(url.searchParams.get("sslmode")).toBe("require");
    expect(url.searchParams.get("schema")).toBe("public");
  });

  it("overrides timeout parameters that were already present in the base URL", () => {
    const url = new URL(
      buildDatasourceUrl("postgresql://postgres:secret@db.example:5432/mergepay?connect_timeout=999")
    );

    expect(url.searchParams.get("connect_timeout")).toBe("10");
  });

  it("round-trips through URL parsing without corrupting the connection string", () => {
    const built = buildDatasourceUrl("postgresql://postgres:secret@db.example:5432/mergepay");

    // Prisma forwards this string to the driver, so it must stay a valid URL.
    expect(() => new URL(built)).not.toThrow();
    expect(built.startsWith("postgresql://postgres:secret@db.example:5432/mergepay?")).toBe(true);
  });
});

describe("queryTimeoutMiddleware", () => {
  it("resolves with the query result when it completes before the timeout", async () => {
    const middleware = queryTimeoutMiddleware(5_000);

    await expect(middleware(params(), async () => "row")).resolves.toBe("row");
  });

  it("rejects with a timeout error when the query hangs past the limit", async () => {
    const middleware = queryTimeoutMiddleware(50);
    const pending = middleware(params(), () => new Promise(() => undefined));

    const assertion = expect(pending).rejects.toThrow("Query timeout after 50ms");
    await vi.advanceTimersByTimeAsync(51);
    await assertion;
  });

  it("clears the race timer once the query resolves so nothing is left pending", async () => {
    const middleware = queryTimeoutMiddleware(5_000);

    await middleware(params(), async () => "ok");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the race timer when the query rejects", async () => {
    const middleware = queryTimeoutMiddleware(5_000);

    await expect(
      middleware(params(), async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a settled query be affected by the still-pending timer race", async () => {
    const middleware = queryTimeoutMiddleware(10);

    // The query wins the race; the timeout timer must not overwrite the result
    // (a Promise.race settles once — this pins that contract).
    const result = middleware(params(), async () => "winner");
    await vi.advanceTimersByTimeAsync(11);

    await expect(result).resolves.toBe("winner");
  });
});
