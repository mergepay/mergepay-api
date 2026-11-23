import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { z } from "zod";
import { AppError, ErrorCode, Errors } from "../src/lib/errors";
import { TimeoutError, TransportError } from "../src/services/timeout";
import {
  errorHandlerPlugin,
  resolveError,
  serializeError,
  type ResolvedError,
} from "../src/plugins/error-handler";
import type { FormattedErrorResponse } from "../src/utils/error-response";

function thrownZodError(): unknown {
  try {
    z.object({ name: z.string().min(1) }).parse({ name: "" });
  } catch (error) {
    return error;
  }
  throw new Error("unreachable");
}

function ajvError(): unknown {
  return Object.assign(new Error("body/name must be string"), {
    code: "FST_ERR_VALIDATION",
    validation: [{ instancePath: "/name", keyword: "type", message: "must be string" }],
  });
}

function prismaError(code: string, meta?: Record<string, unknown>): unknown {
  return Object.assign(new Error(`raw driver text for ${code}`), {
    name: "PrismaClientKnownRequestError",
    code,
    meta,
  });
}

function horizonError(resultCodes: Record<string, unknown>, status = 400): unknown {
  return Object.assign(new Error("Request failed with status code 400: SECRETXDR"), {
    response: {
      status,
      data: { extras: { result_codes: resultCodes, envelope_xdr: "SECRETXDR" } },
    },
  });
}

interface MappingCase {
  name: string;
  error: unknown;
  status: number;
  code: string;
  message?: string;
  check?: (resolved: ResolvedError, body: FormattedErrorResponse) => void;
}

const cases: MappingCase[] = [
  {
    name: "null throws map to a generic 500",
    error: null,
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    message: "Something went wrong.",
  },
  {
    name: "undefined throws map to a generic 500",
    error: undefined,
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
  },
  {
    name: "plain strings map to a generic 500 without echoing text",
    error: "secret-string",
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("secret-string"),
  },
  {
    name: "plain numbers map to a generic 500",
    error: 42,
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
  },
  {
    name: "plain objects map to a generic 500",
    error: { password: "hunter2" },
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("hunter2"),
  },
  {
    name: "Zod errors map to 400 VALIDATION_ERROR with issues",
    error: thrownZodError(),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    check: (resolved) => {
      expect(Array.isArray(resolved.issues)).toBe(true);
      expect(Array.isArray(resolved.details)).toBe(true);
      expect(resolved.issues?.[0]).toMatchObject({ path: expect.any(Array), code: expect.any(String) });
    },
  },
  {
    name: "Ajv errors map to 400 VALIDATION_ERROR with field details",
    error: ajvError(),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    check: (resolved) => {
      expect(resolved.issues?.[0]).toMatchObject({ path: ["name"], message: "must be string" });
      expect(resolved.details?.[0]).toMatchObject({ field: "name", code: "type" });
    },
  },
  {
    name: "malformed JSON maps to 400 without parser text",
    error: Object.assign(new SyntaxError("Unexpected token 's', secret payload"), { statusCode: 400 }),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    message: "Request body must be valid JSON.",
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("secret payload"),
  },
  {
    name: "empty JSON body maps to 400 without parser text",
    error: Object.assign(new Error("empty body"), { code: "FST_ERR_CTP_EMPTY_JSON_BODY" }),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    message: "Request body must be valid JSON.",
  },
  {
    name: "explicit 401 AppErrors keep their code",
    error: Errors.unauthorized(),
    status: 401,
    code: ErrorCode.UNAUTHORIZED,
  },
  {
    name: "explicit 403 AppErrors keep their code",
    error: Errors.forbidden(),
    status: 403,
    code: ErrorCode.FORBIDDEN,
  },
  {
    name: "explicit 404 AppErrors keep their code",
    error: Errors.notFound("gone"),
    status: 404,
    code: ErrorCode.NOT_FOUND,
  },
  {
    name: "explicit 409 AppErrors keep their specific code",
    error: Errors.conflict("already_settled", "already settled"),
    status: 409,
    code: "ALREADY_SETTLED",
  },
  {
    name: "explicit 502 AppErrors keep their code and message",
    error: Errors.upstream("Anchor unavailable"),
    status: 502,
    code: ErrorCode.UPSTREAM_ERROR,
    message: "Anchor unavailable",
  },
  {
    name: "explicit AppError details stay on the envelope",
    error: new AppError(400, ErrorCode.VALIDATION_ERROR, "Bad input", [{ field: "amount" }]),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
    check: (resolved) => expect(resolved.details).toEqual([{ field: "amount" }]),
  },
  {
    name: "generic 400 maps to BAD_REQUEST with fixed text",
    error: Object.assign(new Error("secret request body"), { statusCode: 400 }),
    status: 400,
    code: ErrorCode.BAD_REQUEST,
    message: "Bad request",
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("secret request body"),
  },
  {
    name: "generic 401 maps to UNAUTHORIZED",
    error: { statusCode: 401 },
    status: 401,
    code: ErrorCode.UNAUTHORIZED,
  },
  {
    name: "generic 403 maps to FORBIDDEN",
    error: { status: 403 },
    status: 403,
    code: ErrorCode.FORBIDDEN,
  },
  {
    name: "generic 404 maps to NOT_FOUND",
    error: { statusCode: 404 },
    status: 404,
    code: ErrorCode.NOT_FOUND,
  },
  {
    name: "generic 409 maps to CONFLICT",
    error: { statusCode: 409 },
    status: 409,
    code: ErrorCode.CONFLICT,
  },
  {
    name: "generic 429 maps to RATE_LIMITED",
    error: { statusCode: 429 },
    status: 429,
    code: ErrorCode.RATE_LIMITED,
  },
  {
    name: "unlisted 4xx statuses keep their status and use BAD_REQUEST",
    error: { statusCode: 418, message: "teapot" },
    status: 418,
    code: ErrorCode.BAD_REQUEST,
    message: "Bad request",
  },
  {
    name: "generic 5xx statuses fall back to INTERNAL_ERROR",
    error: { statusCode: 503 },
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
  },
  {
    name: "out-of-range statuses fall back to INTERNAL_ERROR",
    error: { status: 200 },
    status: 500,
    code: ErrorCode.INTERNAL_ERROR,
  },
  {
    name: "body too large maps to 413",
    error: Object.assign(new Error("raw"), { code: "FST_ERR_CTP_BODY_TOO_LARGE" }),
    status: 413,
    code: ErrorCode.REQUEST_TOO_LARGE,
  },
  {
    name: "wrong multipart content type maps to 415",
    error: Object.assign(new Error("raw"), { code: "FST_INVALID_MULTIPART_CONTENT_TYPE" }),
    status: 415,
    code: ErrorCode.BAD_REQUEST,
  },
  {
    name: "malformed multipart body maps to 400 with fixed text",
    error: new Error("Unexpected end of form: secret bytes"),
    status: 400,
    code: ErrorCode.BAD_REQUEST,
    message: "Malformed multipart request.",
  },
  {
    name: "Prisma unique violation maps to 409",
    error: prismaError("P2002", { target: ["email"] }),
    status: 409,
    code: ErrorCode.DUPLICATE_RECORD,
    check: (resolved) => expect(resolved.details).toEqual({ fields: ["email"] }),
  },
  {
    name: "Prisma bad value maps to 400",
    error: prismaError("P2000", { target: ["name"] }),
    status: 400,
    code: ErrorCode.VALIDATION_ERROR,
  },
  {
    name: "Prisma missing record maps to 404",
    error: prismaError("P2025"),
    status: 404,
    code: ErrorCode.NOT_FOUND,
  },
  {
    name: "Prisma write conflict maps to 409",
    error: prismaError("P2034"),
    status: 409,
    code: ErrorCode.CONFLICT,
  },
  {
    name: "Prisma connection failure maps to 503",
    error: Object.assign(new Error("connect ECONNREFUSED db.internal"), {
      name: "PrismaClientInitializationError",
      errorCode: "P1001",
    }),
    status: 503,
    code: ErrorCode.SERVICE_UNAVAILABLE,
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("db.internal"),
  },
  {
    name: "Horizon sequence conflict maps to 409",
    error: horizonError({ transaction: "tx_bad_seq" }),
    status: 409,
    code: "STELLAR_SEQUENCE_CONFLICT",
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("SECRETXDR"),
  },
  {
    name: "Horizon funding failure maps to 422",
    error: horizonError({ transaction: "tx_failed", operations: ["op_underfunded"] }),
    status: 422,
    code: "STELLAR_INSUFFICIENT_FUNDS",
  },
  {
    name: "unknown Horizon result codes map to 502 PROVIDER_REJECTED",
    error: horizonError({ operations: ["op_unlisted"] }),
    status: 502,
    code: ErrorCode.PROVIDER_REJECTED,
  },
  {
    name: "Horizon network timeout maps to 504",
    error: Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" }),
    status: 504,
    code: "UPSTREAM_TIMEOUT",
  },
  {
    name: "Horizon provider rate limit follows the 503 convention",
    error: Object.assign(new Error("raw upstream text: SECRETXDR"), {
      name: "BadRequestError",
      operation: "Horizon.loadAccount",
      response: { status: 429, headers: { "retry-after": "7" } },
    }),
    status: 503,
    code: ErrorCode.SERVICE_UNAVAILABLE,
    check: (resolved, body) => {
      expect(resolved.headers?.["Retry-After"]).toBe("7");
      expect(resolved.retryAfter).toBe(7);
      expect(resolved.details).toMatchObject({ retryAfterSeconds: 7 });
      expect(JSON.stringify(body)).not.toContain("raw upstream text");
    },
  },
  {
    name: "provider 503 maps to 502 UPSTREAM_ERROR",
    error: Object.assign(new Error("raw upstream text"), {
      response: { status: 503 },
      operation: "Horizon.loadAccount",
    }),
    status: 502,
    code: ErrorCode.UPSTREAM_ERROR,
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("raw upstream text"),
  },
  {
    name: "provider 400 without result codes maps to 502 UPSTREAM_ERROR",
    error: Object.assign(new Error("raw upstream text"), {
      response: { status: 400 },
      operation: "Horizon.loadAccount",
    }),
    status: 502,
    code: ErrorCode.UPSTREAM_ERROR,
  },
  {
    name: "escaping TimeoutError maps to 502 without operation text",
    error: new TimeoutError("Horizon.loadAccount", 1000),
    status: 502,
    code: ErrorCode.UPSTREAM_ERROR,
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("Horizon.loadAccount"),
  },
  {
    name: "escaping TransportError maps to 502 without cause text",
    error: new TransportError("Horizon.loadAccount", "ECONNREFUSED 10.0.0.1 secret"),
    status: 502,
    code: ErrorCode.UPSTREAM_ERROR,
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("10.0.0.1"),
  },
  {
    name: "status plus code/operation is not mistaken for a provider failure",
    error: Object.assign(new Error("top secret internal detail"), {
      status: 400,
      code: ErrorCode.INVALID_ACCOUNT,
      operation: "createExpense",
    }),
    status: 400,
    code: ErrorCode.BAD_REQUEST,
    message: "Bad request",
    check: (_resolved, body) => expect(JSON.stringify(body)).not.toContain("top secret internal detail"),
  },
  {
    name: "statusCode plus a provider-looking operation is still a generic 4xx",
    error: Object.assign(new Error("raw"), {
      statusCode: 400,
      code: ErrorCode.INVALID_SPLIT,
      operation: "Horizon.loadAccount",
    }),
    status: 400,
    code: ErrorCode.BAD_REQUEST,
  },
];

describe("canonical error status/code map (#1040)", () => {
  it.each(cases)("$name", (testCase) => {
    const resolved = resolveError(testCase.error);
    expect(resolved.status).toBe(testCase.status);
    expect(resolved.code).toBe(testCase.code);
    if (testCase.message !== undefined) expect(resolved.message).toBe(testCase.message);

    const body = serializeError(testCase.error, "req-map");
    expect(body.error.code).toBe(testCase.code);
    expect(body.code).toBe(testCase.code);
    expect(body.error.message).toBe(resolved.message);
    expect(body.message).toBe(resolved.message);
    expect(body.requestId).toBe("req-map");
    expect(body.error.requestId).toBe("req-map");
    expect(body).not.toHaveProperty("statusCode");
    expect(JSON.stringify(body)).not.toContain("stack");
    testCase.check?.(resolved, body);
  });

  it("is deterministic when an error carries several status signals", () => {
    const error = Object.assign(new Error("raw"), {
      statusCode: 400,
      status: 500,
      code: "SOMETHING",
      operation: "Horizon.loadAccount",
    });

    expect(resolveError(error)).toEqual(resolveError(error));
    expect(resolveError(error).status).toBe(400);
  });

  it("serves the canonical mapping through the Fastify error handler", async () => {
    const app = Fastify({ logger: false });
    await app.register(errorHandlerPlugin);
    app.get("/regression", async () => {
      throw Object.assign(new Error("top secret internal detail"), {
        status: 400,
        code: ErrorCode.INVALID_ACCOUNT,
        operation: "createExpense",
      });
    });

    const res = await app.inject({ method: "GET", url: "/regression" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(res.json().error.message).toBe("Bad request");
    expect(res.body).not.toContain("top secret internal detail");
    await app.close();
  });
});
