/**
 * The Pino serializer configuration as it is actually wired into the Fastify
 * instance (src/lib/logger.ts + src/app.ts).
 *
 * The unit tests for the serializer functions themselves live in
 * tests/serializers.test.ts and tests/error-serializer.test.ts. What this file
 * pins is the wiring, which is where a credential would escape even if every
 * serializer were correct in isolation:
 *
 *  1. The shared option set registers the `req`, `res`, and `err` serializers
 *     and the redaction paths, and the Fastify instance is built from it.
 *  2. A request that carries credentials produces log lines — including the
 *     "incoming request" / "request completed" lines Fastify writes itself —
 *     with those credentials redacted and the request id, status code, and
 *     telemetry headers intact.
 *  3. The serialized request stays small: no socket, no raw body, no entire
 *     header bag of unrelated noise.
 *  4. The default logger used by the rest of the suite runs the same
 *     serializers against a destination that discards its input, so a
 *     serializer that throws or a secret that slips through fails `npm test`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
import { Errors } from "../src/lib/errors";
import { buildLoggerOptions, LOGGER_SERIALIZERS, REDACT_PATHS } from "../src/lib/logger";

/** A bearer token and a session cookie that must never reach a log line. */
const BEARER_TOKEN = "eyJhbGciOiJIUzI1NiJ9.dG9rZW4tc2VjcmV0";
const SESSION_COOKIE = "session=s3cr3t-value";

/** Structured lines captured from the app's logger. */
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

/** Log lines for one request, matched on the Fastify request-id binding. */
function linesFor(requestId: string): Record<string, any>[] {
  return lines.filter((line) => line.reqId === requestId || line.requestId === requestId);
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  // The production option set, with its destination swapped for a buffer — the
  // configuration under test is exactly the one `buildApp` builds for itself.
  app = await buildApp({
    logger: { ...buildLoggerOptions({ level: "trace" }), stream: capture },
  });

  // A route that sets a session cookie, so the response serializer has a
  // credential to redact.
  app.get("/logging/cookie", async (_request, reply) => {
    reply.header("set-cookie", "session=issued-by-the-server; HttpOnly; Secure");
    return { ok: true };
  });

  // A route that fails with a server-side error, so the error serializer runs
  // on a real request. A 5xx is the branch that logs the error object; a 4xx is
  // an expected rejection and is logged without one (see the onError hook).
  app.get("/logging/boom", async () => {
    throw Errors.internal("Widget registry unavailable");
  });
});

afterAll(async () => {
  await app?.close();
});

describe("shared logger options", () => {
  it("registers serializers for requests, responses, errors, and tx hashes", () => {
    expect(Object.keys(LOGGER_SERIALIZERS).sort()).toEqual([
      "err",
      "intendedTxHash",
      "req",
      "res",
      "stellarTransactionHash",
      "stellarTxHash",
      "transactionHash",
      "txHash",
    ]);
    for (const serializer of Object.values(LOGGER_SERIALIZERS)) {
      expect(typeof serializer).toBe("function");
    }
  });

  it("shortens Stellar transaction hashes through the shared serializer map", () => {
    const hash =
      "a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00";
    expect(LOGGER_SERIALIZERS.txHash(hash)).toBe("a1b2c3d4…ddeeff00");
    expect(LOGGER_SERIALIZERS.stellarTxHash("not-a-hash")).toBe(
      "[invalid-tx-hash]"
    );
  });

  it("censors the authorization and cookie headers, and credential-shaped fields", () => {
    expect(REDACT_PATHS).toContain("req.headers.authorization");
    expect(REDACT_PATHS).toContain("req.headers.cookie");
    expect(REDACT_PATHS).toContain("res.headers.set-cookie");
    expect(REDACT_PATHS).toContain("token");
    expect(REDACT_PATHS).toContain("privateKey");
  });

  it("builds an options object that carries the serializers and redaction", () => {
    const options = buildLoggerOptions({ level: "info" });

    expect(options.level).toBe("info");
    expect(options.serializers).toMatchObject(LOGGER_SERIALIZERS);
    expect(options.redact).toMatchObject({ censor: "[REDACTED]" });
    expect(options.redact).toMatchObject({
      paths: expect.arrayContaining(["req.headers.authorization", "req.headers.cookie"]),
    });
    // `pino-pretty` is a development affordance; it must not be on by default.
    expect(options.transport).toBeUndefined();
  });

  it("hands each logger its own copy of the redaction paths", () => {
    const first = buildLoggerOptions({ level: "info" });
    const second = buildLoggerOptions({ level: "info" });

    expect(first.redact?.paths).not.toBe(second.redact?.paths);
    expect(first.redact?.paths).toEqual(second.redact?.paths);
  });
});

describe("request logging through the Fastify instance", () => {
  it("redacts credentials while keeping the request id and telemetry headers", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        cookie: SESSION_COOKIE,
        "x-request-id": "req-serializer-test",
        "user-agent": "mergepay-tests/1.0",
      },
    });
    expect(res.statusCode).toBe(200);

    const requestLines = linesFor("req-serializer-test");
    const incoming = requestLines.find((line) => line.msg === "incoming request");
    expect(incoming).toBeDefined();

    const logged = incoming!.req;
    expect(logged.method).toBe("GET");
    expect(logged.url).toBe("/health/live");
    expect(logged.headers.authorization).toBe("[REDACTED]");
    expect(logged.headers.cookie).toBe("[REDACTED]");
    expect(logged.headers["x-request-id"]).toBe("req-serializer-test");
    expect(logged.headers["user-agent"]).toBe("mergepay-tests/1.0");

    // The credential is gone from the whole output, not just from `req`.
    const output = JSON.stringify(requestLines);
    expect(output).not.toContain(BEARER_TOKEN);
    expect(output).not.toContain("s3cr3t-value");
    expect(output).not.toContain("Bearer ");
  });

  it("keeps the response status code and redacts a set-cookie on the way out", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/logging/cookie",
      headers: { "x-request-id": "req-response-test" },
    });
    expect(res.statusCode).toBe(200);
    // The cookie really is on the wire — the assertion below is about the log.
    expect(res.headers["set-cookie"]).toContain("session=issued-by-the-server");

    const completed = linesFor("req-response-test").find(
      (line) => line.msg === "request completed" && line.res
    );
    expect(completed?.res.statusCode).toBe(200);
    expect(completed?.res.headers["set-cookie"]).toBe("[REDACTED]");
    expect(completed?.res.headers["content-type"]).toContain("application/json");
    expect(JSON.stringify(completed)).not.toContain("issued-by-the-server");
  });

  it("does not serialize the socket, the raw body, or the request object itself", async () => {
    await app.inject({
      method: "GET",
      url: "/health/live?probe=1",
      headers: { "x-request-id": "req-bloat-test" },
    });

    const logged = linesFor("req-bloat-test").find((line) => line.msg === "incoming request")!.req;
    for (const key of ["socket", "raw", "body", "server"]) {
      expect(logged).not.toHaveProperty(key);
    }
    // A compact, fixed shape rather than a dump of the incoming message.
    expect(Object.keys(logged).length).toBeLessThanOrEqual(8);
    expect(logged.query).toEqual({ probe: "1" });
  });

  it("logs a failed request with the error's code and status", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/logging/boom",
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        "x-request-id": "req-error-test",
      },
    });
    expect(res.statusCode).toBe(500);
    // The message is safe for the client, so it is echoed in the envelope.
    expect(res.json().error.code).toBe("INTERNAL_ERROR");

    const failure = linesFor("req-error-test").find(
      (line) => line.msg === "request failed"
    );
    expect(failure?.level).toBe(50);
    expect(failure?.errorCode).toBe("INTERNAL_ERROR");
    expect(failure?.statusCode).toBe(500);
    expect(failure?.err.type).toBe("AppError");
    expect(failure?.err.message).toBe("Widget registry unavailable");
    expect(failure?.err.code).toBe("INTERNAL_ERROR");
    expect(failure?.err.statusCode).toBe(500);
    expect(failure?.err.stack).toContain("Widget registry unavailable");
  });
});

describe("credentials logged outside a serializer", () => {
  it("censors a token logged as its own field", () => {
    const logger = pino({ ...buildLoggerOptions({ level: "trace" }) }, capture);
    lines.length = 0;

    logger.info(
      { token: BEARER_TOKEN, privateKey: "SABC-secret", groupId: "group_1" },
      "settlement submit"
    );

    const line = lines[0];
    expect(line.token).toBe("[REDACTED]");
    expect(line.privateKey).toBe("[REDACTED]");
    // Non-credential context survives, or the line would be useless.
    expect(line.groupId).toBe("group_1");
    expect(JSON.stringify(line)).not.toContain(BEARER_TOKEN);
  });
});

describe("the logger the test suite gets by default", () => {
  it("runs the shared serializers against a discarding destination", async () => {
    const defaultApp = await buildApp();
    try {
      // The app's own logger, not an injected one: whatever the suite asserts
      // about logging has to be true of the default configuration.
      const serializers = (defaultApp.log as any)[pino.symbols.serializersSym];
      expect(typeof serializers.req).toBe("function");
      expect(typeof serializers.res).toBe("function");
      expect(typeof serializers.err).toBe("function");
      expect(serializers.req).toBe(LOGGER_SERIALIZERS.req);
      expect(serializers.err).toBe(LOGGER_SERIALIZERS.err);

      // Emitting a line with each serialized field neither throws nor writes
      // anything to the terminal.
      expect(() =>
        defaultApp.log.info(
          {
            req: { method: "GET", url: "/health", headers: { authorization: `Bearer ${BEARER_TOKEN}` } },
            res: { statusCode: 200, headers: { "set-cookie": SESSION_COOKIE } },
            err: Errors.internal("boom"),
          },
          "test run"
        )
      ).not.toThrow();

      const res = await defaultApp.inject({ method: "GET", url: "/health/live" });
      expect(res.statusCode).toBe(200);
    } finally {
      await defaultApp.close();
    }
  });
});
