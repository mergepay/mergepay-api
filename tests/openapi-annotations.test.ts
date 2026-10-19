/**
 * API documentation contract for the group management and expense routes.
 *
 * These routes carry real Zod validation in their handlers; the OpenAPI
 * annotations exist so `@fastify/swagger-ui` renders a usable contract for
 * frontend developers. This test builds the real app (with only the database
 * stubbed, since building the spec never touches it) and asserts the generated
 * spec actually contains the documented paths, tags, request bodies, and the
 * 400/401/403/404 error responses the issue calls for.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../src/db", () => {
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

import { buildApp } from "../src/app";

let spec: any;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  spec = (app as any).swagger();
});

/** Fetch a documented operation, or fail with a readable message. */
function operation(path: string, method: string): any {
  const item = spec.paths[path];
  expect(item, `missing documented path ${path}`).toBeTruthy();
  const op = item[method];
  expect(op, `missing ${method.toUpperCase()} ${path}`).toBeTruthy();
  return op;
}

describe("OpenAPI: group management routes", () => {
  it("registers a Groups tag", () => {
    expect(spec.tags.map((t: any) => t.name)).toContain("Groups");
  });

  it("documents group creation with a body and validation/auth errors", () => {
    const op = operation("/api/v1/groups", "post");
    expect(op.tags).toContain("Groups");
    expect(op.summary).toBeTruthy();
    expect(op.requestBody).toBeTruthy();
    expect(op.responses["200"]).toBeTruthy();
    expect(op.responses["400"]).toBeTruthy();
    expect(op.responses["401"]).toBeTruthy();
  });

  it("documents member addition (invite and join) with bodies", () => {
    const invite = operation("/api/v1/groups/{id}/invite", "post");
    expect(invite.tags).toContain("Groups");
    expect(invite.requestBody).toBeTruthy();
    expect(invite.responses["400"]).toBeTruthy();
    expect(invite.responses["403"]).toBeTruthy();

    const join = operation("/api/v1/groups/join", "post");
    expect(join.requestBody).toBeTruthy();
    expect(join.responses["400"]).toBeTruthy();
    expect(join.responses["404"]).toBeTruthy();
  });

  it("documents role changes and member removal with 4xx responses", () => {
    const role = operation("/api/v1/groups/{id}/members/role", "post");
    expect(role.requestBody).toBeTruthy();
    for (const status of ["400", "401", "403", "404"]) {
      expect(role.responses[status], `missing ${status} on role change`).toBeTruthy();
    }

    const remove = operation("/api/v1/groups/{id}/members/{memberId}", "delete");
    expect(remove.parameters?.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(["id", "memberId"])
    );
    expect(remove.responses["403"]).toBeTruthy();
    expect(remove.responses["404"]).toBeTruthy();
  });
});

describe("OpenAPI: expense routes", () => {
  it("documents expense creation with body, response, and 4xx codes", () => {
    const op = operation("/api/v1/groups/{id}/expenses", "post");
    expect(op.tags).toContain("Expenses");
    expect(op.requestBody).toBeTruthy();
    expect(op.responses["200"]).toBeTruthy();
    for (const status of ["400", "401", "403", "404"]) {
      expect(op.responses[status], `missing ${status} on expense create`).toBeTruthy();
    }
  });

  it("documents expense read, update, and delete", () => {
    const get = operation("/api/v1/expenses/{id}", "get");
    expect(get.responses["404"]).toBeTruthy();

    const patch = operation("/api/v1/expenses/{id}", "patch");
    expect(patch.requestBody).toBeTruthy();
    expect(patch.responses["403"]).toBeTruthy();

    const del = operation("/api/v1/expenses/{id}", "delete");
    expect(del.responses["404"]).toBeTruthy();
  });
});

describe("OpenAPI: settlement routes", () => {
  it("documents settlement creation and confirmation with error codes", () => {
    const create = operation("/api/v1/groups/{id}/settlements", "post");
    expect(create.tags).toContain("Settlements");
    expect(create.requestBody).toBeTruthy();
    expect(create.responses["400"]).toBeTruthy();
    expect(create.responses["429"]).toBeTruthy();

    const confirm = operation("/api/v1/settlements/{id}/confirm", "post");
    expect(confirm.requestBody).toBeTruthy();
    expect(confirm.responses["404"]).toBeTruthy();
  });
});

describe("OpenAPI: SEP-24 withdrawal routes (#663)", () => {
  /** Every JSON Schema keyword present in a tree, however deeply nested. */
  function keywords(node: unknown, found = new Set<string>()): Set<string> {
    if (Array.isArray(node)) {
      for (const entry of node) keywords(entry, found);
      return found;
    }
    if (!node || typeof node !== "object") return found;
    for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
      found.add(keyword);
      keywords(value, found);
    }
    return found;
  }

  it("documents the withdrawal initiation, confirmation, and read operations", () => {
    const start = operation("/api/v1/withdraw", "post");
    expect(start.tags).toContain("SEP-24");
    expect(start.summary).toBeTruthy();
    expect(start.description).toBeTruthy();
    expect(start.requestBody?.content?.["application/json"]?.schema).toBeTruthy();
    for (const status of ["200", "400", "401", "429"]) {
      expect(start.responses[status], `missing ${status} on POST /withdraw`).toBeTruthy();
    }

    const confirm = operation("/api/v1/withdraw/{id}/confirm", "post");
    expect(confirm.tags).toContain("SEP-24");
    expect(confirm.requestBody?.content?.["application/json"]?.schema).toBeTruthy();
    for (const status of ["200", "400", "401", "404", "429"]) {
      expect(confirm.responses[status], `missing ${status} on POST /withdraw/{id}/confirm`).toBeTruthy();
    }

    const read = operation("/api/v1/withdraw/{id}", "get");
    expect(read.tags).toContain("SEP-24");
    for (const status of ["200", "401", "403", "404"]) {
      expect(read.responses[status], `missing ${status} on GET /withdraw/{id}`).toBeTruthy();
    }
  });

  it("names the id path parameter on both :id withdrawal routes", () => {
    for (const [path, method] of [
      ["/api/v1/withdraw/{id}", "get"],
      ["/api/v1/withdraw/{id}/confirm", "post"],
    ] as const) {
      const op = operation(path, method);
      const id = op.parameters?.find((p: any) => p.name === "id");
      expect(id, `no documented id parameter on ${method.toUpperCase()} ${path}`).toBeTruthy();
      expect(id.in).toBe("path");
      expect(id.required).toBe(true);
    }
  });

  it("documents the withdrawal payloads without the keywords that would let Fastify reject them", () => {
    // The handlers own the rules, so ajv must not answer in its own words (or
    // strip a field) before Zod can name the offending one — the same contract
    // the interactive SEP-24 routes already keep.
    for (const [path, method] of [
      ["/api/v1/withdraw", "post"],
      ["/api/v1/withdraw/{id}/confirm", "post"],
    ] as const) {
      const body = operation(path, method).requestBody.content["application/json"].schema;
      expect(body.additionalProperties).toBe(true);
      expect(body.required).toEqual([]);
      const found = keywords(body);
      for (const rule of ["pattern", "minLength", "maxLength", "format"]) {
        expect(found.has(rule), `${rule} on ${path} would let Fastify reject before Zod`).toBe(false);
      }
    }
  });

  it("still documents the fields each withdrawal body takes", () => {
    const start = operation("/api/v1/withdraw", "post");
    expect(Object.keys(start.requestBody.content["application/json"].schema.properties)).toEqual(
      expect.arrayContaining(["amount", "assetCode", "memo"])
    );

    const confirm = operation("/api/v1/withdraw/{id}/confirm", "post");
    expect(
      Object.keys(confirm.requestBody.content["application/json"].schema.properties)
    ).toContain("signedXdr");
  });
});
