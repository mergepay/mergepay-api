/**
 * Prisma/PostgreSQL constraint violations translated into API errors (issue #398).
 *
 * Three layers, because the mapping is only useful if all three hold:
 *
 *  1. `toPrismaError` itself — every documented Prisma code, both `meta` shapes
 *     across client versions, and the guarantee that a non-Prisma error is left
 *     alone (a mistranslated socket error would turn a 502 into a 500).
 *  2. The central error handler — real `PrismaClientKnownRequestError` instances
 *     thrown from a route, asserted on the wire, plus one real write (POST
 *     /groups) whose mocked `group.create` rejects, proving no service or
 *     repository had to change for the mapping to apply.
 *  3. The log — the operator still gets the original driver error, the code, and
 *     the constraint name, while none of that reaches the client.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { Writable } from "node:stream";
import { Keypair } from "@stellar/stellar-sdk";

const h = vi.hoisted(() => {
  const model = () => ({
    create: vi.fn(),
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    updateMany: vi.fn(),
    upsert: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";
import { signToken } from "../src/plugins/auth";
import { toPrismaError } from "../src/lib/prisma-error";
import { AppError, Errors, ErrorCode } from "../src/lib/errors";
import pino from "pino";

const prisma = h.prisma;
const CLIENT_VERSION = "5.18.0";

/** A real Prisma known-request error, the way the client throws one. */
function knownError(code: string, message: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: CLIENT_VERSION,
    meta,
  });
}

/** A real `PrismaClientInitializationError` — it carries `errorCode`, not `code`. */
function initError(errorCode: string) {
  return new Prisma.PrismaClientInitializationError(
    `Can't reach database server at \`db.internal:5432\` (auth failed for user "mergepay")`,
    CLIENT_VERSION,
    errorCode
  );
}

// ---------------------------------------------------------------------------
// 1. The mapping itself
// ---------------------------------------------------------------------------
describe("toPrismaError: constraint violations", () => {
  it("maps a unique-constraint violation to 409 DUPLICATE_RECORD", () => {
    const translated = toPrismaError(
      knownError("P2002", "Unique constraint failed on the fields: (`groupId`,`userId`)", {
        modelName: "GroupMember",
        target: ["groupId", "userId"],
      })
    );

    expect(translated).toMatchObject({
      status: 409,
      code: ErrorCode.DUPLICATE_RECORD,
      prismaCode: "P2002",
      retryable: false,
    });
    // Fixed, client-facing prose — never Prisma's own message.
    expect(translated?.message).toBe("A record with these values already exists.");
    expect(translated?.details).toEqual({
      fields: ["groupId", "userId"],
      model: "GroupMember",
    });
  });

  it("reads the older single-string `target` and keeps the constraint out of the details", () => {
    const translated = toPrismaError(
      knownError("P2002", "Unique constraint failed", {
        constraint: "settlement_expense_share_idempotency",
        target: "expenseShareId",
      })
    );

    expect(translated?.status).toBe(409);
    expect(translated?.details).toEqual({ fields: ["expenseShareId"] });
    // Postgres naming: logged, never shipped to a client.
    expect(translated?.constraint).toBe("settlement_expense_share_idempotency");
  });

  it("omits details entirely when Prisma sent no meta", () => {
    const translated = toPrismaError(knownError("P2002", "Unique constraint failed"));

    expect(translated?.status).toBe(409);
    expect(translated).not.toHaveProperty("details");
  });

  it("drops meta values that are not identifiers, so no value can leak", () => {
    const translated = toPrismaError(
      knownError("P2002", "Unique constraint failed", {
        target: ["stellarPublicKey"],
        // A hostile/odd shape: prose, SQL, an oversized token, a nested object.
        constraint: "Unique constraint failed on the fields: (`email`)",
        modelName: { name: "User" },
      })
    );

    expect(translated?.details).toEqual({ fields: ["stellarPublicKey"] });
    expect(translated?.constraint).toBeUndefined();
    expect(JSON.stringify(translated)).not.toContain("email");
  });

  it("bounds a long field list", () => {
    const target = Array.from({ length: 50 }, (_, i) => `field${i}`);
    const translated = toPrismaError(knownError("P2002", "Unique constraint failed", { target }));

    expect(translated?.details?.fields).toHaveLength(10);
  });

  it("maps a foreign-key violation to 400 and names the reference", () => {
    const translated = toPrismaError(
      knownError("P2003", "Foreign key constraint violated on the field: `groupId`", {
        field_name: "groupId",
      })
    );

    expect(translated).toMatchObject({ status: 400, code: ErrorCode.VALIDATION_ERROR });
    expect(translated?.message).toBe("A referenced record does not exist.");
    expect(translated?.details).toEqual({ fields: ["groupId"] });
  });

  it.each([
    ["P2000", "A value is too long for this field."],
    ["P2004", "A database constraint rejected this value."],
    ["P2007", "A value is not valid for this field."],
    ["P2011", "A required field was missing."],
    ["P2012", "A required value was not provided."],
    ["P2014", "A required related record was not provided."],
  ])("maps %s to 400 VALIDATION_ERROR", (code, message) => {
    const translated = toPrismaError(knownError(code, `driver text for ${code}`));

    expect(translated).toMatchObject({
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      prismaCode: code,
      retryable: false,
    });
    expect(translated?.message).toBe(message);
  });

  it.each(["P2001", "P2025"])("maps %s to 404 NOT_FOUND", (code) => {
    const translated = toPrismaError(knownError(code, "No record was found for an operation"));

    expect(translated).toMatchObject({
      status: 404,
      code: ErrorCode.NOT_FOUND,
      prismaCode: code,
    });
  });

  it("maps a write conflict to a retryable 409", () => {
    const translated = toPrismaError(
      knownError("P2034", "Transaction failed due to a write conflict or a deadlock")
    );

    expect(translated).toMatchObject({
      status: 409,
      code: ErrorCode.CONFLICT,
      retryable: true,
    });
    expect(translated?.message).toContain("retry");
  });

  it("keeps a malformed raw query a 500, with text that is not the statement", () => {
    const sql = "INSERT INTO \"Group\" (\"secret_column\") VALUES ('hunter2')";
    const translated = toPrismaError(knownError("P2010", `Raw query failed. Code: \`${sql}\``));

    expect(translated).toMatchObject({ status: 500, code: ErrorCode.INTERNAL_ERROR, retryable: false });
    expect(translated?.message).toBe("A database query failed.");
    expect(translated?.message).not.toContain("hunter2");
  });
});

describe("toPrismaError: an unreachable database", () => {
  it.each(["P1000", "P1001", "P1002", "P1008", "P1011", "P1017"])(
    "maps lifecycle code %s to a retryable 503",
    (code) => {
      const translated = toPrismaError(knownError(code, "Can't reach database server"));

      expect(translated).toMatchObject({
        status: 503,
        code: ErrorCode.SERVICE_UNAVAILABLE,
        prismaCode: code,
        retryable: true,
      });
    }
  );

  it("maps an initialization error, which carries errorCode rather than code", () => {
    const translated = toPrismaError(initError("P1001"));

    expect(translated).toMatchObject({
      status: 503,
      code: ErrorCode.SERVICE_UNAVAILABLE,
      prismaCode: "PrismaClientInitializationError",
      retryable: true,
    });
  });

  it("maps a query-validation error to a 500 without echoing the query", () => {
    const translated = toPrismaError(
      new Prisma.PrismaClientValidationError(
        "Invalid `prisma.group.create()` invocation: { data: { secretKey: 'hunter2' } }",
        CLIENT_VERSION
      )
    );

    expect(translated).toMatchObject({ status: 500, code: ErrorCode.INTERNAL_ERROR });
    expect(translated?.message).not.toContain("hunter2");
  });

  it("maps an unrecognised driver failure to a 500", () => {
    const translated = toPrismaError(
      new Prisma.PrismaClientUnknownRequestError("Something the driver did not explain", {
        clientVersion: CLIENT_VERSION,
      })
    );

    expect(translated?.status).toBe(500);
  });
});

describe("toPrismaError: errors that are not Prisma's", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "P2002"],
    ["a number", 42],
    ["a plain Error", new Error("Unique constraint failed on the fields: (`email`)")],
    ["a TypeError", new TypeError("cannot read property x of undefined")],
    [
      "a socket error",
      Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:5432"), { code: "ECONNREFUSED" }),
    ],
    ["an AppError", Errors.conflict("already_settled", "Your share is already settled")],
    ["a Fastify limit error", Object.assign(new Error("too large"), { code: "FST_ERR_CTP_BODY_TOO_LARGE" })],
  ])("returns null for %s", (_label, error) => {
    expect(toPrismaError(error)).toBeNull();
  });

  it("does not claim an AppError that happens to carry a Prisma-looking code", () => {
    // A service may set `code` for its own reasons; an AppError keeps its own
    // status and code, and the handler checks that first.
    const error = new AppError(409, ErrorCode.LAST_ADMIN, "You are the last admin");
    (error as unknown as Record<string, unknown>).code = "P2002";

    expect(toPrismaError(error)?.code).toBe(ErrorCode.DUPLICATE_RECORD);
  });

  it("leaves the horizon-shaped errors alone", () => {
    const horizon = Object.assign(new Error("Transaction failed"), {
      response: { status: 400 },
      operation: "Horizon.submitPayment",
      code: "tx_failed",
    });

    expect(toPrismaError(horizon)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. The central error handler
// ---------------------------------------------------------------------------
const USER = {
  id: "user_1",
  stellarPublicKey: Keypair.random().publicKey(),
  displayName: "Admin",
  avatarUrl: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function authHeader() {
  return { authorization: `Bearer ${signToken({ id: USER.id, stellarPublicKey: USER.stellarPublicKey })}` };
}

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();

  // Routes that throw the exact errors Prisma throws, so the handler sees what
  // it would see in production rather than a stand-in.
  app.get("/test/prisma-duplicate", async () => {
    throw knownError("P2002", "Unique constraint failed on the fields: (`inviteePublicKey`)", {
      modelName: "Invitation",
      target: ["groupId", "inviteePublicKey"],
    });
  });

  app.get("/test/prisma-foreign-key", async () => {
    throw knownError("P2003", "Foreign key constraint violated on the field: `groupId`", {
      field_name: "groupId",
    });
  });

  app.get("/test/prisma-missing-record", async () => {
    throw knownError("P2025", "An operation failed because it depends on one or more required records");
  });

  app.get("/test/prisma-unavailable", async () => {
    throw initError("P1001");
  });
});

afterAll(async () => {
  await app?.close();
});

describe("the error handler: a rejected write", () => {
  it("answers a unique-constraint violation with 409 and the conflicting columns", async () => {
    const res = await app.inject({ method: "GET", url: "/test/prisma-duplicate" });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.DUPLICATE_RECORD);
    expect(body.message).toBe("A record with these values already exists.");
    expect(body.requestId).toBeTruthy();
    expect(body.error.details.fields).toEqual(["groupId", "inviteePublicKey"]);
  });

  it("answers a foreign-key violation with 400", async () => {
    const res = await app.inject({ method: "GET", url: "/test/prisma-foreign-key" });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(body.message).toBe("A referenced record does not exist.");
    expect(body.error.details.fields).toEqual(["groupId"]);
  });

  it("answers a vanished record with 404", async () => {
    const res = await app.inject({ method: "GET", url: "/test/prisma-missing-record" });

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe(ErrorCode.NOT_FOUND);
  });

  it("answers an unreachable database with 503 rather than 500", async () => {
    const res = await app.inject({ method: "GET", url: "/test/prisma-unavailable" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(body.message).toBe("The database is temporarily unavailable. Please retry shortly.");
    // The driver's text carries the host and the username — it must not ship.
    expect(JSON.stringify(body)).not.toContain("db.internal");
    expect(JSON.stringify(body)).not.toContain("mergepay");
  });

  it("never echoes the driver's message on the wire", async () => {
    const res = await app.inject({ method: "GET", url: "/test/prisma-duplicate" });

    expect(res.json().message).not.toContain("Unique constraint failed");
    expect(res.payload).not.toContain("PrismaClientKnownRequestError");
  });
});

describe("the error handler: a real route, no service changes", () => {
  beforeEach(() => {
    prisma.group.create.mockReset();
    prisma.auditLog.create.mockReset();
  });

  it("maps a rejected POST /groups write to 409", async () => {
    prisma.group.create.mockRejectedValue(
      knownError("P2002", "Unique constraint failed on the fields: (`groupId`,`userId`)", {
        modelName: "GroupMember",
        target: ["groupId", "userId"],
      })
    );

    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: authHeader(),
      payload: { name: "Weekend trip" },
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.code).toBe(ErrorCode.DUPLICATE_RECORD);
    expect(body.error.details).toMatchObject({ fields: ["groupId", "userId"] });
  });
});

// ---------------------------------------------------------------------------
// 3. The log
//
// The app is built with `logger: false` under test, so the suite injects its
// own Pino instance (the same one tests/error-handler-logging.test.ts uses) and
// asserts against what an operator would actually see.
// ---------------------------------------------------------------------------
const logLines: any[] = [];
const capture = new Writable({
  write(chunk, _enc, cb) {
    for (const line of chunk.toString().trim().split("\n")) {
      if (line) logLines.push(JSON.parse(line));
    }
    cb();
  },
});
const logger = pino({ level: "trace", serializers: { err: pino.stdSerializers.err } }, capture);

/** Let any buffered log writes flush before asserting. */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

let loggingApp: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  loggingApp = await buildApp({ logger });

  loggingApp.get("/log/prisma-duplicate", async () => {
    throw knownError("P2002", "Unique constraint failed on the fields: (`expenseShareId`)", {
      constraint: "settlement_expense_share_idempotency",
      target: ["expenseShareId", "idempotencyKey"],
    });
  });

  loggingApp.get("/log/prisma-unavailable", async () => {
    throw initError("P1001");
  });
});

afterAll(async () => {
  await loggingApp?.close();
});

describe("the log behind a translated database error", () => {
  beforeEach(() => {
    logLines.length = 0;
  });

  it("keeps the driver error, the code, and the constraint server-side only", async () => {
    const res = await loggingApp.inject({
      method: "GET",
      url: "/log/prisma-duplicate",
      headers: { "x-request-id": "req-prisma-1" },
    });
    await settle();

    expect(res.statusCode).toBe(409);

    const entry = logLines.find((line) => line.msg === "Database error");
    expect(entry).toBeDefined();
    expect(entry.requestId).toBe("req-prisma-1");
    expect(entry.errorCode).toBe(ErrorCode.DUPLICATE_RECORD);
    expect(entry.prismaCode).toBe("P2002");
    // The constraint name and the original driver error are logged, so an
    // operator has them.
    expect(entry.constraint).toBe("settlement_expense_share_idempotency");
    expect(entry.err.message).toContain("Unique constraint failed");

    // ...while the response carries the fixed message and the columns only.
    expect(res.payload).not.toContain("Unique constraint failed");
    expect(res.payload).not.toContain("settlement_expense_share_idempotency");
    expect(JSON.parse(res.payload).error.details).toEqual({
      fields: ["expenseShareId", "idempotencyKey"],
    });
  });

  it("logs a client mistake below warn and an outage at warn", async () => {
    await loggingApp.inject({ method: "GET", url: "/log/prisma-duplicate" });
    await loggingApp.inject({ method: "GET", url: "/log/prisma-unavailable" });
    await settle();

    const entries = logLines.filter((line) => line.msg === "Database error");
    expect(entries).toHaveLength(2);
    // DEBUG (20) for a duplicate the caller can fix; WARN (40) for a database
    // this process cannot reach.
    expect(entries[0].level).toBe(20);
    expect(entries[1].level).toBe(40);
    expect(entries[1].errorCode).toBe(ErrorCode.SERVICE_UNAVAILABLE);
  });
});
