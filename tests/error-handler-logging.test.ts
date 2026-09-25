import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";

vi.mock("../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    group: { findUnique: vi.fn() },
    groupMember: { findUnique: vi.fn() },
    idempotencyKey: { findUnique: vi.fn(), create: vi.fn() },
    auditLog: { create: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../src/services/stellar", async (importActual) => {
  const actual = await importActual<typeof import("../src/services/stellar")>();
  return {
    ...actual,
    stellar: {
      ...actual.stellar,
      loadAccount: vi.fn(async () => ({
        exists: false,
        sequence: "0",
        balances: [],
        signers: [],
        thresholds: { low: 0, med: 0, high: 0 },
      })),
    },
  };
});

import { buildApp } from "../src/app";
import { AppError, Errors, ErrorCode } from "../src/lib/errors";

/** Pino numeric levels — the values that land in the serialized `level` field. */
const LEVEL = { info: 30, warn: 40, error: 50 } as const;

interface CapturedLog {
  level: number;
  msg?: string;
  reqId?: string;
  correlationId?: string;
  requestId?: string;
  statusCode?: number;
  errorCode?: string;
  err?: { type?: string; message?: string; stack?: string };
  [key: string]: unknown;
}

/**
 * The app is built with `logger: false` under test, so the suite injects its
 * own Pino instance (mirroring the production `err` serializer) that writes
 * JSON lines into this in-memory buffer for assertions.
 */
const logLines: CapturedLog[] = [];
let pending = "";
const capture = new Writable({
  write(chunk, _enc, cb) {
    pending += chunk.toString();
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) {
      if (!part.trim()) continue;
      try {
        logLines.push(JSON.parse(part));
      } catch {
        // Ignore anything that is not a complete JSON line.
      }
    }
    cb();
  },
});

const logger = pino({ level: "trace", serializers: { err: pino.stdSerializers.err } }, capture);

const SECRET_DETAIL = "boom: connect ECONNREFUSED postgres://user:pass@db/mergepay";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp({ logger });

  // A non-AppError: the unknown/unhandled branch of the error handler.
  app.get("/log/unexpected", async () => {
    throw new Error(SECRET_DETAIL);
  });

  // A domain error: the AppError branch of the error handler.
  app.get("/log/not-found", async () => {
    throw Errors.notFound("Widget not found");
  });

  app.get("/log/with-details", async () => {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Bad input", [
      { field: "amount", message: "Required" },
    ]);
  });

  // AppError above 500: a server-side fault that must carry a stack.
  app.get("/log/upstream", async () => {
    throw Errors.upstream("Anchor unavailable");
  });
});

afterAll(async () => {
  await app?.close();
});

/** Let any buffered log writes flush before asserting. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Every log line recorded for one request, keyed by its correlation id. */
function logsFor(requestId: string): CapturedLog[] {
  return logLines.filter(
    (line) =>
      line.correlationId === requestId ||
      line.requestId === requestId ||
      line.reqId === requestId
  );
}

describe("Pino logging for the error handler", () => {
  it("logs an unexpected exception at error level with its stack, and answers a clean 500", async () => {
    const res = await app.inject({ method: "GET", url: "/log/unexpected" });
    await settle();

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Something went wrong.");
    expect(body.error.requestId).toBeTruthy();

    // The stack never reaches the client…
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
    expect(body.stack).toBeUndefined();
    expect(body.error.stack).toBeUndefined();

    // …but it is logged at error level (both the onError hook and the
    // handler's fallback log), against the request's correlation id.
    const failureLogs = logsFor(body.requestId).filter(
      (line) => line.level === LEVEL.error && line.msg === "request failed"
    );
    expect(failureLogs.length).toBeGreaterThan(0);
    const first = failureLogs[0];
    expect(first.err?.stack).toContain("ECONNREFUSED");
    expect(first.err?.message).toContain("boom");
    expect(first.statusCode).toBe(500);
    expect(first.errorCode).toBe("INTERNAL_ERROR");

    const fallbackLogs = logsFor(body.requestId).filter(
      (line) => line.level === LEVEL.error && line.msg === "Unhandled error"
    );
    expect(fallbackLogs.length).toBeGreaterThan(0);
    expect(JSON.stringify(fallbackLogs[0])).toContain("ECONNREFUSED");
  });

  it("logs client (4xx) errors at warn level without a stack", async () => {
    const res = await app.inject({ method: "GET", url: "/log/not-found" });
    await settle();

    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.error.code).toBe(ErrorCode.NOT_FOUND);

    const failureLogs = logsFor(body.requestId).filter(
      (line) => line.msg === "request failed"
    );
    expect(failureLogs).toHaveLength(1);
    const warnLine = failureLogs[0];
    expect(warnLine.level).toBe(LEVEL.warn);
    expect(warnLine.statusCode).toBe(404);
    expect(warnLine.errorCode).toBe(ErrorCode.NOT_FOUND);
    expect(warnLine.correlationId).toBe(body.requestId);
    // Client errors are logged without the error object, so no stack is emitted.
    expect(warnLine.err).toBeUndefined();

    // Nothing about this expected rejection was logged as a server fault.
    const errorLogs = logsFor(body.requestId).filter(
      (line) => line.level === LEVEL.error
    );
    expect(errorLogs).toHaveLength(0);
  });

  it("logs AppError validation failures at warn level with their code", async () => {
    const res = await app.inject({ method: "GET", url: "/log/with-details" });
    await settle();

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.error.details).toHaveLength(1);

    const warnLine = logsFor(body.requestId).find(
      (line) => line.msg === "request failed"
    );
    expect(warnLine?.level).toBe(LEVEL.warn);
    expect(warnLine?.errorCode).toBe(ErrorCode.VALIDATION_ERROR);
    expect(warnLine?.err).toBeUndefined();

    const errorLogs = logsFor(body.requestId).filter(
      (line) => line.level === LEVEL.error
    );
    expect(errorLogs).toHaveLength(0);
  });

  it("logs server-side AppErrors (>=500) at error level", async () => {
    const res = await app.inject({ method: "GET", url: "/log/upstream" });
    await settle();

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.error.code).toBe(ErrorCode.UPSTREAM_ERROR);

    const failureLogs = logsFor(body.requestId).filter(
      (line) => line.msg === "request failed"
    );
    expect(failureLogs).toHaveLength(1);
    expect(failureLogs[0].level).toBe(LEVEL.error);
    expect(failureLogs[0].statusCode).toBe(502);
    expect(failureLogs[0].errorCode).toBe(ErrorCode.UPSTREAM_ERROR);
    expect(failureLogs[0].err?.stack).toBeTruthy();

    // The response body still carries no stack.
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("keeps successful requests at info level with no error logs", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    await settle();

    expect(res.statusCode).toBe(200);
    const requestId = res.headers["x-request-id"] as string;
    expect(requestId).toBeTruthy();

    const requestLogs = logsFor(requestId);
    expect(requestLogs.some((line) => line.msg === "request received")).toBe(true);
    expect(requestLogs.some((line) => line.msg === "request completed")).toBe(true);
    expect(
      requestLogs.filter((line) => line.level >= LEVEL.warn)
    ).toHaveLength(0);
  });
});
