/**
 * A route is not obliged to throw an `Error`.
 *
 * `throw null` and a promise rejected with no reason (`Promise.reject()`) reach
 * the error pipeline as nullish. The central handler and the `onError` hook both
 * read `.code` / `.statusCode` off the thrown value, so an unguarded read threw a
 * TypeError from inside the pipeline and Fastify fell back to its built-in error
 * body — the single response in this API that skipped the standard envelope,
 * omitted the requestId, and echoed an internal message ("Cannot read properties
 * of null (reading 'code')") to the caller.
 *
 * These tests pin the standard contract for every shape a handler can throw, so
 * a future unguarded property read cannot reintroduce the bypass.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { z } from "zod";

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

import { buildApp } from "../src/app";
import { AppError, Errors, ErrorCode } from "../src/lib/errors";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

  // Nullish throws — the regression this file exists for.
  app.get("/throw/null", async () => {
    throw null; // eslint-disable-line no-throw-literal
  });
  app.get("/throw/undefined", async () => {
    throw undefined; // eslint-disable-line no-throw-literal
  });
  app.get("/throw/rejected-promise", async () => {
    await Promise.reject();
    return {};
  });

  // Shapes that already worked, pinned so the fix cannot narrow them.
  app.get("/throw/string", async () => {
    throw "a bare string"; // eslint-disable-line no-throw-literal
  });
  app.get("/throw/number", async () => {
    throw 42; // eslint-disable-line no-throw-literal
  });
  app.get("/throw/object", async () => {
    throw { secret: "leaky" }; // eslint-disable-line no-throw-literal
  });

  // A non-Error object that still carries a status must keep it.
  app.get("/throw/object-with-status", async () => {
    throw { statusCode: 418, message: "teapot" }; // eslint-disable-line no-throw-literal
  });

  // The branches the nullish guard must not disturb.
  app.get("/throw/app-error", async () => {
    throw Errors.notFound("Widget not found");
  });
  app.get("/throw/zod", async () => {
    const schema = z.object({
      amount: z.number(),
      shares: z.array(z.object({ userId: z.string().min(1) })),
    });
    schema.parse({ amount: "nope", shares: [{ userId: "" }] });
    return {};
  });
  app.get("/throw/error", async () => {
    throw new Error("internal detail: postgres://user:pass@db/mergepay");
  });
});

afterAll(async () => {
  await app?.close();
});

/** The invariants every error response in this API must satisfy. */
function expectStandardEnvelope(
  res: { statusCode: number; body: string; headers: Record<string, unknown> },
  status: number,
  code: string
) {
  expect(res.statusCode).toBe(status);
  const body = JSON.parse(res.body);

  // The canonical nested envelope…
  expect(body.error).toBeDefined();
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe("string");
  expect(body.error.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  // …plus the backwards-compatible top-level mirrors.
  expect(body.code).toBe(code);
  expect(body.message).toBe(body.error.message);
  // Correlation is always present, so a client can quote it in a bug report.
  expect(body.error.requestId).toBeTruthy();
  expect(res.headers["x-request-id"]).toBe(body.error.requestId);

  // The default Fastify body leaked `statusCode`/`error` as bare strings; the
  // standard envelope must not carry that shape.
  expect(body.statusCode).toBeUndefined();
  expect(typeof body.error).toBe("object");

  // No stack, and no internal diagnostic text, ever reaches the client.
  expect(body.stack).toBeUndefined();
  expect(body.error.stack).toBeUndefined();
  expect(res.body).not.toMatch(/Cannot read propert/);
  expect(res.body).not.toMatch(/\bat\s+\w+\s+\(/);
}

describe("nullish and non-Error throws keep the standard error envelope", () => {
  it.each([
    ["null", "/throw/null"],
    ["undefined", "/throw/undefined"],
    ["a promise rejected with no reason", "/throw/rejected-promise"],
  ])("answers a 500 in the standard envelope when a route throws %s", async (_label, url) => {
    const res = await app.inject({ method: "GET", url });
    expectStandardEnvelope(res, 500, ErrorCode.INTERNAL_ERROR);
    expect(res.json().error.message).toBe("Something went wrong.");
  });

  it.each([
    ["a string", "/throw/string"],
    ["a number", "/throw/number"],
    ["a plain object", "/throw/object"],
  ])("answers a 500 in the standard envelope when a route throws %s", async (_label, url) => {
    const res = await app.inject({ method: "GET", url });
    expectStandardEnvelope(res, 500, ErrorCode.INTERNAL_ERROR);
  });

  it("still honours a status carried on a non-Error object", async () => {
    const res = await app.inject({ method: "GET", url: "/throw/object-with-status" });
    expectStandardEnvelope(res, 418, ErrorCode.BAD_REQUEST);
  });

  it("does not regress the AppError branch", async () => {
    const res = await app.inject({ method: "GET", url: "/throw/app-error" });
    expectStandardEnvelope(res, 404, ErrorCode.NOT_FOUND);
    expect(res.json().error.message).toBe("Widget not found");
  });

  it("does not regress the Zod branch's field-level details", async () => {
    const res = await app.inject({ method: "GET", url: "/throw/zod" });
    expectStandardEnvelope(res, 400, ErrorCode.VALIDATION_ERROR);

    const { error } = res.json();
    expect(Array.isArray(error.details)).toBe(true);
    // A nested path is flattened to a dotted field name a client can highlight.
    expect(error.details.map((d: { field: string }) => d.field)).toEqual([
      "amount",
      "shares.0.userId",
    ]);
    for (const detail of error.details) {
      expect(typeof detail.field).toBe("string");
      expect(typeof detail.message).toBe("string");
      expect(typeof detail.code).toBe("string");
    }
  });

  it("does not regress the generic 500 branch, which still withholds the stack", async () => {
    const res = await app.inject({ method: "GET", url: "/throw/error" });
    expectStandardEnvelope(res, 500, ErrorCode.INTERNAL_ERROR);
    expect(res.body).not.toContain("postgres://user:pass");
  });

  it("answers unknown routes in the same envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/throw/nope" });
    expectStandardEnvelope(res, 404, ErrorCode.NOT_FOUND);
  });

  it("keeps the 500 for a nullish throw off Fastify's default body", async () => {
    // Regression guard for the exact bypass: the default handler's body has a
    // bare `error` string and a `statusCode`, and no `error.code` at all.
    const res = await app.inject({ method: "GET", url: "/throw/null" });
    const body = JSON.parse(res.body);
    expect(body.error).not.toBe("Internal Server Error");
    expect(body.error.code).toBeDefined();
    expect(new AppError(500, ErrorCode.INTERNAL_ERROR, "x")).toBeInstanceOf(AppError);
  });
});
