/**
 * The `err` half of the Pino serializer set (src/lib/serializers.ts).
 *
 * An error is the field most likely to smuggle a secret into a log line — it is
 * where a route attaches a validation payload, an upstream body, or a signed
 * envelope — and it is also the field an on-call engineer reads to understand a
 * rejection. These tests pin both halves of that bargain:
 *
 *  1. The debugging metadata survives — `code`, `statusCode`, `requestId`, the
 *     stack, and a Horizon error's problem-detail fields.
 *  2. Credential-shaped keys are redacted, at any depth of the detail payload.
 *
 * The request and response serializers are covered by tests/serializers.test.ts;
 * the end-to-end wiring (Fastify → Pino → these functions) by
 * tests/logger-serializers.test.ts.
 */
import { describe, it, expect } from "vitest";

import { errorSerializer } from "../src/lib/serializers";
import { AppError, Errors, ErrorCode } from "../src/lib/errors";

describe("errorSerializer", () => {
  it("keeps the message, name, and stack of a plain Error", () => {
    const error = new Error("settlement submit failed");

    const result = errorSerializer(error);

    expect(result.type).toBe("Error");
    expect(result.name).toBe("Error");
    expect(result.message).toBe("settlement submit failed");
    expect(result.stack).toContain("settlement submit failed");
  });

  it("keeps the machine-readable code and status of an AppError", () => {
    const result = errorSerializer(Errors.notFound("Group not found"));

    expect(result.type).toBe("AppError");
    expect(result.code).toBe(ErrorCode.NOT_FOUND);
    expect(result.statusCode).toBe(404);
    expect(result.message).toBe("Group not found");
  });

  it("keeps a thrown AppError's structured details", () => {
    const details = [{ field: "amount", message: "Required" }];

    const result = errorSerializer(
      new AppError(400, ErrorCode.VALIDATION_ERROR, "Bad input", details)
    );

    expect(result.details).toEqual(details);
  });

  it("keeps the requestId so a line can be tied back to a request", () => {
    const error = Errors.internal();
    error.requestId = "req-abc123";

    const result = errorSerializer(error);

    expect(result.requestId).toBe("req-abc123");
  });

  it("keeps the correlationId and the upstream operation when present", () => {
    const error = Object.assign(new Error("horizon timeout"), {
      correlationId: "corr-1",
      operation: "Horizon.submitTransaction",
      status: 504,
    });

    const result = errorSerializer(error);

    expect(result.correlationId).toBe("corr-1");
    expect(result.operation).toBe("Horizon.submitTransaction");
    expect(result.statusCode).toBe(504);
  });

  it("ignores a status that is not a number", () => {
    const error = Object.assign(new Error("bad gateway"), { status: "502" });

    const result = errorSerializer(error);

    expect(result).not.toHaveProperty("statusCode");
  });

  it("redacts credential-shaped keys in the details payload", () => {
    const result = errorSerializer(
      new AppError(400, ErrorCode.VALIDATION_ERROR, "Bad input", {
        token: "eyJhbGciOiJIUzI1NiJ9.secret",
        refreshToken: "rt_abc123",
        signedXdr: "AAAAAg...",
        amount: "50.00",
      })
    );

    const details = result.details as Record<string, unknown>;
    expect(details.token).toBe("[REDACTED]");
    expect(details.refreshToken).toBe("[REDACTED]");
    expect(details.signedXdr).toBe("[REDACTED]");
    expect(details.amount).toBe("50.00");
    expect(JSON.stringify(result)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("redacts credentials nested inside arrays and objects in the details", () => {
    const result = errorSerializer(
      new AppError(502, ErrorCode.UPSTREAM_ERROR, "Anchor unavailable", {
        attempts: [
          { endpoint: "/sep24/deposit", authorization: "Bearer anchor-token" },
          { endpoint: "/sep24/withdraw", password: "hunter2" },
        ],
      })
    );

    const attempts = (result.details as any).attempts;
    expect(attempts[0].endpoint).toBe("/sep24/deposit");
    expect(attempts[0].authorization).toBe("[REDACTED]");
    expect(attempts[1].password).toBe("[REDACTED]");
  });

  it("survives a self-referencing details payload", () => {
    const details: Record<string, unknown> = { entityId: "group_1" };
    details.self = details;

    const result = errorSerializer(
      new AppError(500, ErrorCode.INTERNAL_ERROR, "Boom", details)
    );

    const serialized = result.details as Record<string, unknown>;
    expect(serialized.entityId).toBe("group_1");
    expect(serialized.self).toBe("[CIRCULAR]");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("serializes a nested Error instead of dropping it to an empty object", () => {
    const result = errorSerializer(
      new AppError(502, ErrorCode.UPSTREAM_ERROR, "Upstream failed", {
        cause: Errors.notFound("anchor session gone"),
      })
    );

    const cause = (result.details as any).cause;
    expect(cause.message).toBe("anchor session gone");
    expect(cause.code).toBe(ErrorCode.NOT_FOUND);
    expect(cause.statusCode).toBe(404);
  });

  it("stops an error chain that points back at itself", () => {
    const outer = new AppError(500, ErrorCode.INTERNAL_ERROR, "outer failure");
    const inner = new AppError(500, ErrorCode.INTERNAL_ERROR, "inner failure");
    (outer as any).details = { inner };
    (inner as any).details = { outer };

    const result = errorSerializer(outer);

    expect(result.message).toBe("outer failure");
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("cuts off a details payload nested deeper than the depth limit", () => {
    const result = errorSerializer(
      new AppError(500, ErrorCode.INTERNAL_ERROR, "Boom", {
        a: { b: { c: { d: { e: "too deep" } } } },
      })
    );

    expect((result.details as any).a.b.c.d).toBe("[TRUNCATED]");
  });

  it("serializes a Date in the details as an ISO string", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");

    const result = errorSerializer(
      new AppError(409, ErrorCode.CONFLICT, "Already settled", { at })
    );

    expect((result.details as any).at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("does not copy arbitrary own properties of an error", () => {
    const error = Object.assign(new Error("boom"), {
      wholeRequestBody: { user: "someone", password: "hunter2" },
    });

    const result = errorSerializer(error);

    expect(result).not.toHaveProperty("wholeRequestBody");
  });

  it("keeps a Horizon error's problem detail and result codes", () => {
    const horizonError = Object.assign(new Error("Transaction failed"), {
      name: "ResponseError",
      response: {
        status: 400,
        data: {
          result: {
            transaction_result_code: "tx_failed",
            operations: [{ operation_result_code: "op_underfunded" }],
          },
        },
      },
      problem: {
        type: "https://stellar.org/horizon-errors/transaction_failed",
        title: "Transaction Failed",
        detail: "The transaction failed when submitted to the network.",
      },
    });

    const result = errorSerializer(horizonError);

    expect(result.statusCode).toBe(400);
    expect(result.title).toBe("Transaction Failed");
    expect(result.detail).toBe("The transaction failed when submitted to the network.");
    expect(result.transactionResultCode).toBe("tx_failed");
    expect(result.operationResultCodes).toEqual(["op_underfunded"]);
  });

  it("handles a non-Error value without throwing", () => {
    expect(errorSerializer("boom")).toEqual({
      message: "boom",
      type: "Error",
      stack: "",
    });
    expect(errorSerializer(undefined).message).toBe("undefined");
    expect(errorSerializer(null).message).toBe("null");
  });

  it("handles a thrown plain object", () => {
    const result = errorSerializer({ code: "ECONNREFUSED", message: "db is down" });

    expect(result.type).toBe("Error");
    expect(result.message).toBe("db is down");
    expect(result.code).toBe("ECONNREFUSED");
    expect(result.stack).toBe("");
  });

  it("returns a JSON-serializable value for every error shape", () => {
    const shapes: unknown[] = [
      new Error("plain"),
      Errors.notFound("gone"),
      Object.assign(new Error("horizon"), { response: { status: 503 } }),
      { code: "E_ODD", message: "odd" },
      "string error",
      42,
      { nested: { self: undefined } },
    ];

    for (const shape of shapes) {
      expect(() => JSON.stringify(errorSerializer(shape))).not.toThrow();
    }
  });
});
