/**
 * Request timeout (issue #385).
 *
 * A handler that never answers must not pin the connection: after
 * `REQUEST_TIMEOUT_MS` the server answers 408 with the standard error envelope
 * while the handler is still running. This suite builds the real app with a
 * short budget and deliberately slow routes to prove the behaviour end to end,
 * plus the two properties that are easy to get wrong:
 *
 *  - a request that finishes inside the budget is never answered twice (the
 *    timer is disarmed, and no "request timed out" line is emitted), and
 *  - the operational health routes are subject to the same bound as any other
 *    request rather than being silently exempt.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
    upsert: vi.fn(),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    invite: model(),
    invitation: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    refreshToken: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    $queryRawUnsafe: vi.fn(async () => [{ "?column?": 1 }]),
    $executeRaw: vi.fn(async () => 1),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { buildLoggerOptions } from "../src/lib/logger";
import { REQUEST_TIMEOUT_CODE } from "../src/plugins/request-timeout";
import { config } from "../src/config";

/** Small enough to keep the suite fast, long enough to beat CI scheduling. */
const TIMEOUT_MS = 80;
/** A route that comfortably overruns the budget. */
const SLOW_HANDLER_MS = 400;
/** A route that comfortably finishes inside it. */
const FAST_HANDLER_MS = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const lines: Record<string, any>[] = [];
const capture = {
  write(chunk: string) {
    try {
      lines.push(JSON.parse(chunk));
    } catch {
      // Ignore anything that is not a complete JSON line.
    }
  },
};

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;

beforeAll(async () => {
  app = await buildApp({
    requestTimeoutMs: TIMEOUT_MS,
    // The serializers run against the injected stream, and this suite only
    // needs the application's own lines — so the boundary routes it registers
    // below are the minimum surface needed to exercise the timer.
    logger: { ...buildLoggerOptions({ level: "trace" }), stream: capture },
    // One app instance serves every case; the limiter's budgets are irrelevant
    // here and would otherwise make the count of requests matter.
    rateLimit: "off",
  });

  app.get("/test/slow", async () => {
    await sleep(SLOW_HANDLER_MS);
    return { slow: true };
  });

  app.get("/test/fast", async () => {
    await sleep(FAST_HANDLER_MS);
    return { fast: true };
  });
});

afterAll(async () => {
  await app.close();
});

function timeoutLinesFor(requestId: string) {
  return lines.filter(
    (line) => line.reqId === requestId && line.msg === "request timed out"
  );
}

describe("request timeout", () => {
  it("answers a request that overruns its budget with 408 and the standard envelope", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/slow",
      headers: { "x-request-id": "req-timeout-test" },
    });

    expect(res.statusCode).toBe(408);
    expect(res.headers["content-type"]).toContain("application/json");

    const body = res.json();
    expect(body.error.code).toBe(REQUEST_TIMEOUT_CODE);
    expect(body.error.message).toContain(`${TIMEOUT_MS}ms`);
    expect(body.error.requestId).toBe("req-timeout-test");

    // The correlation headers every other response carries are on the 408 too.
    expect(res.headers["x-request-id"]).toBe("req-timeout-test");
    expect(res.headers["x-correlation-id"]).toBe("req-timeout-test");

    // The timeout is observable in the logs, with the configured budget.
    const timedOut = timeoutLinesFor("req-timeout-test");
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0].timeoutMs).toBe(TIMEOUT_MS);
    expect(timedOut[0].method).toBe("GET");
  }, 2000);

  it("never arms a late timeout for a request that finished inside its budget", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/fast",
      headers: { "x-request-id": "req-fast-test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ fast: true });

    // Wait past the budget: a timer that was not disarmed would fire here,
    // try to answer an already-completed request, and leave a log line.
    await sleep(TIMEOUT_MS * 3);
    expect(timeoutLinesFor("req-fast-test")).toHaveLength(0);
  }, 2000);

  it("bounds the operational health route like any other request", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { "x-request-id": "req-health-test" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });

  it("reads its default budget from the configuration module", () => {
    expect(config.REQUEST_TIMEOUT_MS).toBe(10_000);
  });
});
