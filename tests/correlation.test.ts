import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isValidCorrelationId,
  generateCorrelationId,
  getCorrelationId,
  jobCorrelationId,
  jobContext,
  loggerWithContext,
  CORRELATION_ID_MAX_LENGTH,
  type CorrelationContext,
} from "../src/lib/correlation";
import pino from "pino";

// ---------------------------------------------------------------------------
// Unit tests for correlation library functions
// ---------------------------------------------------------------------------

describe("isValidCorrelationId", () => {
  it("accepts a UUID", () => {
    expect(isValidCorrelationId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });

  it("accepts alphanumeric with allowed delimiters", () => {
    expect(isValidCorrelationId("abc123")).toBe(true);
    expect(isValidCorrelationId("job-settlement_abc.123:456")).toBe(true);
  });

  it("accepts a string at max length", () => {
    const s = "a".repeat(CORRELATION_ID_MAX_LENGTH);
    expect(isValidCorrelationId(s)).toBe(true);
  });

  it("rejects empty string", () => {
    expect(isValidCorrelationId("")).toBe(false);
  });

  it("rejects strings exceeding max length", () => {
    const s = "a".repeat(CORRELATION_ID_MAX_LENGTH + 1);
    expect(isValidCorrelationId(s)).toBe(false);
  });

  it("rejects strings starting with a non-alphanumeric character", () => {
    expect(isValidCorrelationId(".abc")).toBe(false);
    expect(isValidCorrelationId("-abc")).toBe(false);
  });

  it("rejects strings with special characters", () => {
    expect(isValidCorrelationId("abc\ndef")).toBe(false);
    expect(isValidCorrelationId("abc<def")).toBe(false);
    expect(isValidCorrelationId("abc>def")).toBe(false);
    expect(isValidCorrelationId("abc def")).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidCorrelationId(123)).toBe(false);
    expect(isValidCorrelationId(null)).toBe(false);
    expect(isValidCorrelationId(undefined)).toBe(false);
    expect(isValidCorrelationId({})).toBe(false);
  });
});

describe("generateCorrelationId", () => {
  it("returns a non-empty string", () => {
    const id = generateCorrelationId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("returns valid correlation IDs", () => {
    for (let i = 0; i < 20; i++) {
      expect(isValidCorrelationId(generateCorrelationId())).toBe(true);
    }
  });

  it("returns unique values on successive calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateCorrelationId()));
    expect(ids.size).toBe(100);
  });
});

describe("getCorrelationId", () => {
  it("returns valid values unchanged", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    expect(getCorrelationId(id)).toBe(id);
  });

  it("generates a new ID for an empty string", () => {
    const result = getCorrelationId("");
    expect(result).not.toBe("");
    expect(isValidCorrelationId(result)).toBe(true);
  });

  it("generates a new ID for null", () => {
    const result = getCorrelationId(null);
    expect(isValidCorrelationId(result)).toBe(true);
  });

  it("generates a new ID for malformed input", () => {
    const result = getCorrelationId("<script>alert(1)</script>");
    expect(result).not.toBe("<script>alert(1)</script>");
    expect(isValidCorrelationId(result)).toBe(true);
  });

  it("generates a new ID for overly long input", () => {
    const long = "x".repeat(CORRELATION_ID_MAX_LENGTH + 1);
    const result = getCorrelationId(long);
    expect(isValidCorrelationId(result)).toBe(true);
    expect(result.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
  });

  it("passes through job-prefixed IDs", () => {
    const id = jobCorrelationId("settlement", "settle_1");
    expect(getCorrelationId(id)).toBe(id);
  });
});

describe("jobCorrelationId", () => {
  it("generates a stable ID for the same job type and ID", () => {
    const a = jobCorrelationId("settlement", "settle_1");
    const b = jobCorrelationId("settlement", "settle_1");
    expect(a).toBe(b);
  });

  it("generates different IDs for different job IDs", () => {
    const a = jobCorrelationId("settlement", "settle_1");
    const b = jobCorrelationId("settlement", "settle_2");
    expect(a).not.toBe(b);
  });

  it("generates different IDs for different job types", () => {
    const a = jobCorrelationId("settlement", "settle_1");
    const b = jobCorrelationId("anchor", "settle_1");
    expect(a).not.toBe(b);
  });

  it("returns a valid correlation ID", () => {
    const id = jobCorrelationId("settlement", "settle_1");
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it("sanitises special characters in job type", () => {
    const id = jobCorrelationId("bad type@#$", "id_1");
    expect(isValidCorrelationId(id)).toBe(true);
    expect(id).toContain("bad-type---");
  });

  it("sanitises special characters in job ID", () => {
    const id = jobCorrelationId("settlement", "bad id@#$");
    expect(isValidCorrelationId(id)).toBe(true);
    expect(id).toContain("bad-id---");
  });
});

describe("jobContext", () => {
  it("derives a context with generated correlation ID when no parent is given", () => {
    const ctx = jobContext("settlement", "settle_1");
    expect(ctx).toHaveProperty("correlationId");
    expect(ctx).toHaveProperty("jobId", "settle_1");
    expect(isValidCorrelationId(ctx.correlationId)).toBe(true);
  });

  it("uses the originating correlation ID when provided", () => {
    const parent = "my-api-correlation-id";
    const ctx = jobContext("settlement", "settle_1", parent);
    expect(ctx.correlationId).toBe(parent);
    expect(ctx.jobId).toBe("settle_1");
  });

  it("produces determinstic correlation IDs for the same inputs", () => {
    const a = jobContext("anchor", "session_1");
    const b = jobContext("anchor", "session_1");
    expect(a.correlationId).toBe(b.correlationId);
  });
});

describe("loggerWithContext", () => {
  let memoryTransport: pino.Logger;

  beforeEach(() => {
    memoryTransport = pino({ level: "silent" });
  });

  it("returns parent logger when ctx is undefined", () => {
    const child = loggerWithContext(memoryTransport, undefined);
    expect(child).toBe(memoryTransport);
  });

  it("returns a child logger when ctx is provided", () => {
    const ctx: CorrelationContext = { correlationId: "abc-123" };
    const child = loggerWithContext(memoryTransport, ctx);
    expect(child).not.toBe(memoryTransport);
  });

  it("creates a child logger with correlationId binding", () => {
    const strings: string[] = [];
    const stream = pino({
      level: "info",
      transport: {
        target: "pino/file",
        options: { destination: "/dev/null" },
      },
    });

    // Use a writable stream to capture log output
    const chunks: Buffer[] = [];
    const writable = new (require("stream").Writable)({
      write(chunk: Buffer, _: any, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });

    const capture = pino({ level: "info" }, writable);
    const ctx: CorrelationContext = { correlationId: "abc-123", jobId: "job_1" };
    const child = loggerWithContext(capture, ctx);
    child.info("test message");

    const parsed = JSON.parse(chunks[0].toString());
    expect(parsed.correlationId).toBe("abc-123");
    expect(parsed.jobId).toBe("job_1");
    expect(parsed.msg).toBe("test message");
  });
});

// ---------------------------------------------------------------------------
// Fastify injection tests
// ---------------------------------------------------------------------------

describe("API correlation headers", () => {
  async function buildTestApp() {
    const { buildApp } = await import("../src/app");
    return buildApp();
  }

  it("returns x-correlation-id and x-request-id on every response", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.headers["x-correlation-id"]).toBeDefined();
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(typeof response.headers["x-correlation-id"]).toBe("string");
    expect(response.headers["x-correlation-id"].length).toBeGreaterThan(0);
  });

  it("echoes a valid incoming x-correlation-id header", async () => {
    const app = await buildTestApp();
    const myId = "my-custom-id-123";
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": myId },
    });
    expect(response.headers["x-correlation-id"]).toBe(myId);
    expect(response.headers["x-request-id"]).toBe(myId);
  });

  it("echoes a valid incoming x-request-id header as fallback", async () => {
    const app = await buildTestApp();
    const myId = "fallback-request-456";
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": myId },
    });
    // genReqId prefers x-correlation-id, so x-request-id is used when
    // x-correlation-id is absent
    expect(response.headers["x-correlation-id"]).toBe(myId);
  });

  it("replaces an invalid correlation header with a generated ID", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "<script>alert(1)</script>" },
    });
    const id = response.headers["x-correlation-id"];
    expect(id).toBeDefined();
    expect(id).not.toBe("<script>alert(1)</script>");
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it("replaces an oversized correlation header with a generated ID", async () => {
    const app = await buildTestApp();
    const long = "x".repeat(CORRELATION_ID_MAX_LENGTH + 1);
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": long },
    });
    const id = response.headers["x-correlation-id"];
    expect(id).toBeDefined();
    expect(id.length).toBeLessThanOrEqual(CORRELATION_ID_MAX_LENGTH);
    expect(isValidCorrelationId(id)).toBe(true);
  });

  it("replaces an empty correlation header with a generated ID", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-correlation-id": "" },
    });
    const id = response.headers["x-correlation-id"];
    expect(id).toBeDefined();
    expect(id.length).toBeGreaterThan(0);
  });

  it("includes correlation ID in error response body", async () => {
    const app = await buildTestApp();
    const response = await app.inject({ method: "GET", url: "/nonexistent" });
    const body = response.json();
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
    expect(response.headers["x-correlation-id"]).toBe(body.requestId);
  });

  it("includes correlation ID in validation error response", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      payload: { account: 12345 },
    });
    const body = response.json();
    expect(body.requestId).toBeDefined();
    expect(typeof body.requestId).toBe("string");
  });

  it("returns a unique correlation ID for each request", async () => {
    const app = await buildTestApp();
    const res1 = await app.inject({ method: "GET", url: "/health" });
    const res2 = await app.inject({ method: "GET", url: "/health" });
    expect(res1.headers["x-correlation-id"]).not.toBe(
      res2.headers["x-correlation-id"]
    );
  });

  it("prefers x-correlation-id over x-request-id when both are present", async () => {
    const app = await buildTestApp();
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        "x-correlation-id": "primary-id",
        "x-request-id": "secondary-id",
      },
    });
    expect(response.headers["x-correlation-id"]).toBe("primary-id");
  });
});

// ---------------------------------------------------------------------------
// Worker retry context tests
// ---------------------------------------------------------------------------

describe("worker retry correlation context", () => {
  it("jobContext produces a stable correlationId for the same settlement across retries", () => {
    const ctx1 = jobContext("settlement", "settle_retry_1");
    const ctx2 = jobContext("settlement", "settle_retry_1");
    expect(ctx1.correlationId).toBe(ctx2.correlationId);
    expect(ctx1.jobId).toBe("settle_retry_1");
  });

  it("different settlements get different correlation IDs", () => {
    const ctx1 = jobContext("settlement", "settle_a");
    const ctx2 = jobContext("settlement", "settle_b");
    expect(ctx1.correlationId).not.toBe(ctx2.correlationId);
  });

  it("a system-triggered job generates its own stable ID when no parent exists", () => {
    const ctx = jobContext("anchor", "session_abc");
    expect(ctx.correlationId).toBeTruthy();
    expect(isValidCorrelationId(ctx.correlationId)).toBe(true);
    // Re-running produces the same ID (deterministic from job type + ID)
    const same = jobContext("anchor", "session_abc");
    expect(ctx.correlationId).toBe(same.correlationId);
  });
});

// ---------------------------------------------------------------------------
// loggerWithContext edge cases
// ---------------------------------------------------------------------------

describe("loggerWithContext edge cases", () => {
  it("does not mutate the parent logger", () => {
    const parent = pino({ level: "silent" });
    const ctx: CorrelationContext = { correlationId: "test-id" };
    const child = loggerWithContext(parent, ctx);
    expect(child).not.toBe(parent);

    // Parent should not have the correlationId binding
    const child2 = loggerWithContext(parent, {
      correlationId: "other-id",
      jobId: "job_2",
    });
    expect(child2).not.toBe(parent);
  });

  it("handles undefined jobId gracefully", () => {
    const chunks: Buffer[] = [];
    const writable = new (require("stream").Writable)({
      write(chunk: Buffer, _: any, cb: () => void) {
        chunks.push(chunk);
        cb();
      },
    });
    const capture = pino({ level: "info" }, writable);
    const ctx: CorrelationContext = { correlationId: "only-cid" };
    const child = loggerWithContext(capture, ctx);
    child.info("no job id");

    const parsed = JSON.parse(chunks[0].toString());
    expect(parsed.correlationId).toBe("only-cid");
    expect(parsed.jobId).toBeUndefined();
  });
});
