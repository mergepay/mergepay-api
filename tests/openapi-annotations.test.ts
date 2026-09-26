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
    const op = operation("/groups", "post");
    expect(op.tags).toContain("Groups");
    expect(op.summary).toBeTruthy();
    expect(op.requestBody).toBeTruthy();
    expect(op.responses["200"]).toBeTruthy();
    expect(op.responses["400"]).toBeTruthy();
    expect(op.responses["401"]).toBeTruthy();
  });

  it("documents member addition (invite and join) with bodies", () => {
    const invite = operation("/groups/{id}/invite", "post");
    expect(invite.tags).toContain("Groups");
    expect(invite.requestBody).toBeTruthy();
    expect(invite.responses["400"]).toBeTruthy();
    expect(invite.responses["403"]).toBeTruthy();

    const join = operation("/groups/join", "post");
    expect(join.requestBody).toBeTruthy();
    expect(join.responses["400"]).toBeTruthy();
    expect(join.responses["404"]).toBeTruthy();
  });

  it("documents role changes and member removal with 4xx responses", () => {
    const role = operation("/groups/{id}/members/role", "post");
    expect(role.requestBody).toBeTruthy();
    for (const status of ["400", "401", "403", "404"]) {
      expect(role.responses[status], `missing ${status} on role change`).toBeTruthy();
    }

    const remove = operation("/groups/{id}/members/{memberId}", "delete");
    expect(remove.parameters?.map((p: any) => p.name)).toEqual(
      expect.arrayContaining(["id", "memberId"])
    );
    expect(remove.responses["403"]).toBeTruthy();
    expect(remove.responses["404"]).toBeTruthy();
  });
});

describe("OpenAPI: expense routes", () => {
  it("documents expense creation with body, response, and 4xx codes", () => {
    const op = operation("/groups/{id}/expenses", "post");
    expect(op.tags).toContain("Expenses");
    expect(op.requestBody).toBeTruthy();
    expect(op.responses["200"]).toBeTruthy();
    for (const status of ["400", "401", "403", "404"]) {
      expect(op.responses[status], `missing ${status} on expense create`).toBeTruthy();
    }
  });

  it("documents expense read, update, and delete", () => {
    const get = operation("/expenses/{id}", "get");
    expect(get.responses["404"]).toBeTruthy();

    const patch = operation("/expenses/{id}", "patch");
    expect(patch.requestBody).toBeTruthy();
    expect(patch.responses["403"]).toBeTruthy();

    const del = operation("/expenses/{id}", "delete");
    expect(del.responses["404"]).toBeTruthy();
  });
});

describe("OpenAPI: settlement routes", () => {
  it("documents settlement creation and confirmation with error codes", () => {
    const create = operation("/groups/{id}/settlements", "post");
    expect(create.tags).toContain("Settlements");
    expect(create.requestBody).toBeTruthy();
    expect(create.responses["400"]).toBeTruthy();
    expect(create.responses["429"]).toBeTruthy();

    const confirm = operation("/settlements/{id}/confirm", "post");
    expect(confirm.requestBody).toBeTruthy();
    expect(confirm.responses["404"]).toBeTruthy();
  });
});
