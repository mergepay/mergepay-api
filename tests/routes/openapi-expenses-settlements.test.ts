import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * Unit test verifying complete OpenAPI/Swagger schema annotations for
 * group expense and settlement routes (#905).
 */

vi.mock("../../src/db", () => {
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
    auditLog: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
  };
  return { prisma };
});

import { buildApp } from "../../src/app";

let spec: any;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  spec = (app as any).swagger();
});

function operation(path: string, method: string): any {
  const item = spec.paths[path];
  expect(item, `missing path ${path}`).toBeTruthy();
  const op = item[method];
  expect(op, `missing ${method.toUpperCase()} ${path}`).toBeTruthy();
  return op;
}

describe("OpenAPI / Swagger Annotations for Expenses & Settlements (#905)", () => {
  describe("Expense routes documentation", () => {
    it("POST /api/v1/groups/{id}/expenses documents tags, summary, and error responses", () => {
      const op = operation("/api/v1/groups/{id}/expenses", "post");
      expect(op.tags).toContain("Expenses");
      expect(op.summary).toBeTruthy();
      expect(op.responses["201"] || op.responses["200"]).toBeTruthy();
      expect(op.responses["400"]).toBeTruthy();
      expect(op.responses["401"]).toBeTruthy();
      expect(op.responses["403"]).toBeTruthy();
    });

    it("GET /api/v1/groups/{id}/expenses documents pagination query params and 200 response", () => {
      const op = operation("/api/v1/groups/{id}/expenses", "get");
      expect(op.tags).toContain("Expenses");
      expect(op.summary).toBeTruthy();
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["401"]).toBeTruthy();
      expect(op.responses["403"]).toBeTruthy();
    });

    it("GET /api/v1/expenses/{id} documents expense lookup", () => {
      const op = operation("/api/v1/expenses/{id}", "get");
      expect(op.tags).toContain("Expenses");
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["404"]).toBeTruthy();
    });

    it("PATCH /api/v1/expenses/{id} documents expense modification", () => {
      const op = operation("/api/v1/expenses/{id}", "patch");
      expect(op.tags).toContain("Expenses");
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["400"]).toBeTruthy();
      expect(op.responses["403"]).toBeTruthy();
    });

    it("DELETE /api/v1/expenses/{id} documents expense deletion", () => {
      const op = operation("/api/v1/expenses/{id}", "delete");
      expect(op.tags).toContain("Expenses");
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["403"]).toBeTruthy();
    });
  });

  describe("Settlement routes documentation", () => {
    it("POST /api/v1/expenses/{id}/settle documents expense share settlement", () => {
      const op = operation("/api/v1/expenses/{id}/settle", "post");
      expect(op.tags).toContain("Settlements");
      expect(op.summary).toBeTruthy();
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["400"]).toBeTruthy();
      expect(op.responses["403"]).toBeTruthy();
    });

    it("POST /api/v1/groups/{id}/settlements documents group settlement intent creation", () => {
      const op = operation("/api/v1/groups/{id}/settlements", "post");
      expect(op.tags).toContain("Settlements");
      expect(op.summary).toBeTruthy();
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["400"]).toBeTruthy();
      expect(op.responses["403"]).toBeTruthy();
    });

    it("POST /api/v1/settlements/{id}/confirm documents on-chain settlement confirmation", () => {
      const op = operation("/api/v1/settlements/{id}/confirm", "post");
      expect(op.tags).toContain("Settlements");
      expect(op.summary).toBeTruthy();
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["400"]).toBeTruthy();
    });

    it("GET /api/v1/settlements/{id}/status documents settlement status check", () => {
      const op = operation("/api/v1/settlements/{id}/status", "get");
      expect(op.tags).toContain("Settlements");
      expect(op.responses["200"]).toBeTruthy();
      expect(op.responses["404"]).toBeTruthy();
    });
  });

  describe("Group and expense response schemas (#1047)", () => {
    /** The 200 response body schema, as Fastify/serializer documents it. */
    function responseSchema(op: any): any {
      if (op.responses["200"]?.content) {
        return op.responses["200"].content["application/json"].schema;
      }
      return op.responses["200"];
    }

    /** Resolve the component schema a route response references. */
    function referencedSchema(op: any, envelope: string): any {
      const ref = responseSchema(op).properties?.[envelope]?.$ref;
      expect(ref, `missing $ref for ${envelope}`).toBeTruthy();
      const name = String(ref).split("/").pop();
      const schema = spec.components.schemas[name];
      expect(schema, `missing component schema ${name}`).toBeTruthy();
      // Named for operators reading the Swagger UI.
      expect(schema.title).toBe(
        envelope === "group" ? "Group" : "Expense"
      );
      return schema;
    }

    it("documents the group entity on the group endpoints", () => {
      const created = referencedSchema(
        operation("/api/v1/groups", "post"),
        "group"
      );
      expect(Object.keys(created.properties)).toEqual(
        expect.arrayContaining(["id", "name", "archived", "createdAt"])
      );

      const detail = referencedSchema(
        operation("/api/v1/groups/{id}", "get"),
        "group"
      );
      expect(detail.properties.name.type).toBe("string");

      const list = operation("/api/v1/groups", "get");
      expect(responseSchema(list).properties.groups.items.$ref).toBeTruthy();
    });

    it("documents the expense entity on the expense endpoints", () => {
      const created = referencedSchema(
        operation("/api/v1/groups/{id}/expenses", "post"),
        "expense"
      );
      expect(Object.keys(created.properties)).toEqual(
        expect.arrayContaining([
          "id",
          "groupId",
          "payerUserId",
          "amount",
          "assetCode",
          "splitType",
          "shares",
        ])
      );

      referencedSchema(operation("/api/v1/expenses/{id}", "get"), "expense");
      referencedSchema(operation("/api/v1/expenses/{id}", "patch"), "expense");
    });

    it("documents the expense list pagination and filter query parameters", () => {
      const op = operation("/api/v1/groups/{id}/expenses", "get");
      const properties = op.parameters
        ? Object.fromEntries(
            op.parameters
              .filter((parameter: any) => parameter.in === "query")
              .map((parameter: any) => [parameter.name, parameter])
          )
        : {};

      expect(Object.keys(properties)).toEqual(
        expect.arrayContaining([
          "limit",
          "cursor",
          "order",
          "status",
          "asset",
          "startDate",
          "endDate",
        ])
      );
      expect(responseSchema(op).properties.nextCursor).toBeTruthy();
    });
  });
});
