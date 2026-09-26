import { describe, it, expect, beforeAll, vi } from "vitest";

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
import {
  formatErrorResponse,
  type FormattedErrorResponse,
} from "../src/utils/error-response";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Unit tests — the formatter helper itself
// ---------------------------------------------------------------------------

describe("formatErrorResponse helper", () => {
  it("builds a payload with code, message, timestamp, and requestId", () => {
    const payload: FormattedErrorResponse = formatErrorResponse(
      "NOT_FOUND",
      "Thing not found",
      "req-abc123"
    );

    expect(payload.error).toEqual({
      code: "NOT_FOUND",
      message: "Thing not found",
      timestamp: expect.any(String),
      requestId: "req-abc123",
    });
    expect(payload.code).toBe("NOT_FOUND");
    expect(payload.message).toBe("Thing not found");
    expect(payload.requestId).toBe("req-abc123");
  });

  it("always emits an ISO-8601 timestamp", () => {
    const payload = formatErrorResponse("INTERNAL_ERROR", "Something went wrong.", "req-1");
    expect(Number.isNaN(Date.parse(payload.error.timestamp))).toBe(false);
  });

  it("omits requestId when none is supplied", () => {
    const payload = formatErrorResponse("BAD_REQUEST", "Missing field");
    expect(payload.error.requestId).toBeUndefined();
    expect(payload.requestId).toBeUndefined();
  });

  it("includes details when supplied", () => {
    const details = [{ field: "amount", message: "Required" }];
    const payload = formatErrorResponse("VALIDATION_ERROR", "Bad input", "req-1", details);
    expect(payload.error.details).toEqual(details);
    expect(payload.error.issues).toBeUndefined();
  });

  it("includes issues when supplied (Zod issue list)", () => {
    const issues = [{ path: ["name"], message: "Required", code: "invalid_type" }];
    const payload = formatErrorResponse("VALIDATION_ERROR", "Bad input", "req-1", undefined, issues);
    expect(payload.error.issues).toEqual(issues);
    expect(payload.error.details).toBeUndefined();
  });

  it("omits details and issues when they are undefined", () => {
    const payload = formatErrorResponse("NOT_FOUND", "Route not found", "req-1", undefined, undefined);
    expect(payload.error).not.toHaveProperty("details");
    expect(payload.error).not.toHaveProperty("issues");
  });

  it("never includes a stack trace or status code in the payload", () => {
    const payload = formatErrorResponse(
      "INTERNAL_ERROR",
      "Something went wrong.",
      "req-1",
      undefined,
      undefined,
    );
    expect(payload.error).not.toHaveProperty("stack");
    expect(payload.error).not.toHaveProperty("statusCode");
    expect(JSON.stringify(payload)).not.toContain("statusCode");
  });
});

// ---------------------------------------------------------------------------
// Integration tests — the payload contract as served by the error handler
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

  app.get("/test/er/not-found", async () => {
    throw Errors.notFound("Thing not found");
  });

  app.get("/test/er/bad-request", async () => {
    throw Errors.badRequest("invalid_account", "Not a valid Stellar public key");
  });

  app.get("/test/er/with-details", async () => {
    throw new AppError(400, ErrorCode.VALIDATION_ERROR, "Bad input", [
      { field: "amount", message: "Required" },
    ]);
  });

  app.get("/test/er/zod-error", async () => {
    z.object({ name: z.string().min(1) }).parse({ name: "" });
  });

  app.get("/test/er/internal", async () => {
    throw new Error("DB exploded: secret connection string");
  });
});

describe("standardized error payload (integration)", () => {
  const cases = [
    { url: "/test/er/not-found", status: 404, code: "NOT_FOUND" },
    { url: "/test/er/bad-request", status: 400, code: "INVALID_ACCOUNT" },
    { url: "/test/er/with-details", status: 400, code: "VALIDATION_ERROR" },
    { url: "/test/er/zod-error", status: 400, code: "VALIDATION_ERROR" },
    { url: "/test/er/internal", status: 500, code: "INTERNAL_ERROR" },
    { url: "/does/not/exist", status: 404, code: "NOT_FOUND" },
  ];

  it.each(cases)(
    "$url → $status with the standard { error: { code, message, timestamp, requestId } } envelope",
    async ({ url, status, code }) => {
      const res = await app.inject({ method: "GET", url });
      expect(res.statusCode).toBe(status);

      const body = res.json();
      // Canonical envelope…
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(code);
      expect(typeof body.error.message).toBe("string");
      expect(body.error.message.length).toBeGreaterThan(0);
      expect(typeof body.error.timestamp).toBe("string");
      expect(Number.isNaN(Date.parse(body.error.timestamp))).toBe(false);
      expect(typeof body.error.requestId).toBe("string");
      expect(body.error.requestId.length).toBeGreaterThan(0);
      // …and its backwards-compatible top-level mirror.
      expect(body.code).toBe(body.error.code);
      expect(body.message).toBe(body.error.message);
      expect(body.requestId).toBe(body.error.requestId);
      // Never leaked internals.
      expect(body).not.toHaveProperty("stack");
      expect(body).not.toHaveProperty("statusCode");
      expect(body.error).not.toHaveProperty("stack");
    },
  );

  it("uses the request's own requestId (header propagation)", async () => {
    const res = await app.inject({ method: "GET", url: "/test/er/not-found" });
    const requestId = res.headers["x-request-id"];
    expect(typeof requestId).toBe("string");
    expect(res.json().error.requestId).toBe(requestId);
  });

  it("mints a fresh requestId per request", async () => {
    const res1 = await app.inject({ method: "GET", url: "/test/er/not-found" });
    const res2 = await app.inject({ method: "GET", url: "/test/er/not-found" });
    expect(res1.json().error.requestId).not.toBe(res2.json().error.requestId);
  });

  it("propagates a client-supplied x-request-id into the error payload", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/test/er/not-found",
      headers: { "x-request-id": "req-my-correlation-id-1" },
    });
    expect(res.json().error.requestId).toBe("req-my-correlation-id-1");
  });

  it("serializes AppError details into error.details", async () => {
    const res = await app.inject({ method: "GET", url: "/test/er/with-details" });
    const body = res.json();
    expect(body.error.details).toEqual([{ field: "amount", message: "Required" }]);
    expect(body.error).not.toHaveProperty("issues");
  });
});

describe("Zod validation errors (integration)", () => {
  it("returns a detailed issue list under error.details", async () => {
    const res = await app.inject({ method: "GET", url: "/test/er/zod-error" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(Array.isArray(body.error.details)).toBe(true);
    for (const detail of body.error.details) {
      expect(typeof detail.field).toBe("string");
      expect(typeof detail.message).toBe("string");
      expect(typeof detail.code).toBe("string");
    }
  });

  it("returns a standardized issues array with path, message, and code", async () => {
    const res = await app.inject({ method: "GET", url: "/test/er/zod-error" });
    const body = res.json();
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.length).toBeGreaterThan(0);
    for (const issue of body.error.issues) {
      expect(Array.isArray(issue.path)).toBe(true);
      expect(typeof issue.message).toBe("string");
      expect(typeof issue.code).toBe("string");
      expect(issue).not.toHaveProperty("stack");
    }
  });

  it("carries no stack trace for validation errors", async () => {
    const res = await app.inject({ method: "GET", url: "/test/er/zod-error" });
    const body = res.json();
    expect(body.stack).toBeUndefined();
    expect(body.error.stack).toBeUndefined();
    expect(body.error.details?.[0]?.stack).toBeUndefined();
    expect(body.error.issues?.[0]?.stack).toBeUndefined();
  });
});

describe("internal server errors (integration)", () => {
  it("returns a sanitized 500 envelope without leaking the underlying message", async () => {
    const res = await app.inject({ method: "GET", url: "/test/er/internal" });
    expect(res.statusCode).toBe(500);

    const body = res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Something went wrong.");
    expect(body.error.message).not.toContain("DB exploded");
    expect(body.error.message).not.toContain("secret connection string");
    expect(body.error).not.toHaveProperty("stack");
    expect(body.error).not.toHaveProperty("details");
    expect(JSON.stringify(body)).not.toContain("DB exploded");
  });
});

describe("malformed and empty JSON bodies (integration)", () => {
  it("answers malformed JSON with the standard VALIDATION_ERROR envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: '{ name: "not valid json"',
    });
    expect(res.statusCode).toBe(400);

    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Request body must be valid JSON.");
    expect(typeof body.error.requestId).toBe("string");
    expect(body.error).not.toHaveProperty("stack");
    // The parser's own message (which quotes the malformed input) is never echoed.
    expect(JSON.stringify(body)).not.toContain("Unexpected token");
  });

  it("answers an empty JSON body with the same standard envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/challenge",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);

    const body = res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("Request body must be valid JSON.");
    expect(typeof body.error.requestId).toBe("string");
  });
});
