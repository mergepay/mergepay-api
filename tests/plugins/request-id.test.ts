/**
 * Focused coverage for the correlation-ID middleware (issue #1077).
 *
 * The app-level propagation tests in tests/correlation.test.ts cover the many
 * header shapes; this suite pins the middleware's own contract: one ID drives
 * the response headers and every request-scoped log line, including lines
 * written by route handlers.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import { buildApp } from "../../src/app";
import {
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  resolveIncomingRequestId,
} from "../../src/plugins/request-id";
import { isValidCorrelationId } from "../../src/lib/correlation";

describe("request-id middleware (#1077)", () => {
  describe("resolveIncomingRequestId", () => {
    it("prefers an incoming X-Request-ID", () => {
      expect(
        resolveIncomingRequestId({ [REQUEST_ID_HEADER]: "trace-from-client" })
      ).toBe("trace-from-client");
    });

    it("falls back to X-Correlation-ID", () => {
      expect(
        resolveIncomingRequestId({ [CORRELATION_ID_HEADER]: "trace-from-anchor" })
      ).toBe("trace-from-anchor");
    });

    it("generates a bounded log-safe ID when no usable header is present", () => {
      for (const headers of [
        {},
        { [REQUEST_ID_HEADER]: ["duplicate", "headers"] },
        { [REQUEST_ID_HEADER]: "has spaces" },
        { [REQUEST_ID_HEADER]: "" },
        { [REQUEST_ID_HEADER]: "x".repeat(129) },
      ]) {
        const resolved = resolveIncomingRequestId(headers);
        expect(isValidCorrelationId(resolved)).toBe(true);
      }
    });
  });

  describe("Fastify lifecycle", () => {
    const lines: Array<Record<string, unknown>> = [];
    let pending = "";
    const capture = new Writable({
      write(chunk, _enc, cb) {
        pending += chunk.toString();
        const parts = pending.split("\n");
        pending = parts.pop() ?? "";
        for (const part of parts) {
          if (!part.trim()) continue;
          try {
            lines.push(JSON.parse(part) as Record<string, unknown>);
          } catch {
            // Ignore partial lines.
          }
        }
        cb();
      },
    });
    const logger = pino({ level: "trace" }, capture);

    let app: Awaited<ReturnType<typeof buildApp>>;

    beforeAll(async () => {
      app = await buildApp({ logger, rateLimit: "off" });
      app.get("/corr/hello", async (request) => {
        request.log.info({ marker: "handler" }, "handler log");
        return { ok: true };
      });
      app.get("/corr/fail", async () => {
        throw new Error("correlation failure");
      });
    });

    afterAll(async () => {
      await app?.close();
    });

    it("echoes a client-supplied ID on success, errors, and 404s", async () => {
      for (const url of ["/corr/hello", "/corr/fail", "/corr/missing"]) {
        const res = await app.inject({
          method: "GET",
          url,
          headers: { [REQUEST_ID_HEADER]: "client-trace-123" },
        });
        expect(res.headers[REQUEST_ID_HEADER]).toBe("client-trace-123");
        expect(res.headers[CORRELATION_ID_HEADER]).toBe("client-trace-123");
      }
    });

    it("binds the same ID to request, handler, completion, and error logs", async () => {
      lines.length = 0;
      const res = await app.inject({
        method: "GET",
        url: "/corr/hello",
        headers: { [REQUEST_ID_HEADER]: "bound-trace-456" },
      });
      await new Promise((resolve) => setImmediate(resolve));

      const correlated = lines.filter(
        (line) => line.correlationId === "bound-trace-456"
      );
      const messages = correlated.map((line) => line.msg);
      expect(messages).toContain("request received");
      expect(messages).toContain("handler log");
      expect(messages).toContain("request completed");
      expect(correlated.every((line) => line.reqId === "bound-trace-456")).toBe(true);
      expect(correlated.find((line) => line.msg === "handler log")?.marker).toBe("handler");
      expect(res.headers[REQUEST_ID_HEADER]).toBe("bound-trace-456");
    });

    it("logs errors with the request's correlation ID", async () => {
      lines.length = 0;
      await app.inject({
        method: "GET",
        url: "/corr/fail",
        headers: { [REQUEST_ID_HEADER]: "error-trace-789" },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(
        lines.some(
          (line) =>
            line.correlationId === "error-trace-789" && line.msg === "request failed"
        )
      ).toBe(true);
    });

    it("replaces a malformed incoming ID with a valid one everywhere", async () => {
      lines.length = 0;
      const res = await app.inject({
        method: "GET",
        url: "/corr/hello",
        headers: { [REQUEST_ID_HEADER]: "spaces are not allowed" },
      });
      await new Promise((resolve) => setImmediate(resolve));

      const responseId = res.headers[REQUEST_ID_HEADER];
      expect(typeof responseId).toBe("string");
      expect(isValidCorrelationId(responseId)).toBe(true);
      expect(responseId).not.toBe("spaces are not allowed");
      expect(res.headers[CORRELATION_ID_HEADER]).toBe(responseId);
      expect(lines.some((line) => line.correlationId === responseId)).toBe(true);
      expect(
        lines.some((line) => line.correlationId === "spaces are not allowed")
      ).toBe(false);
    });
  });
});
