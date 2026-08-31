/**
 * Verifies the OpenAPI / Swagger spec generated for the expense settlement
 * routes (issue #332). The schema annotations live on the route definitions
 * in src/routes/expenses.ts and src/routes/settlements.ts; @fastify/swagger
 * builds them into a machine-readable spec served at /docs/json. Registering
 * the routes already fails loudly on a malformed schema (the build-time
 * `schema is invalid` errors), so loading the spec cleanly is the assertion
 * that the annotations convert without error and the expense/settlement
 * operations are actually present.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const model = () => ({});
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    expense: model(),
    expenseShare: model(),
    settlement: model(),
    treasuryTransaction: model(),
    treasuryProposal: model(),
    invite: model(),
    invitation: model(),
    anchorSession: model(),
    auditLog: model(),
    idempotencyKey: model(),
    withdrawal: model(),
    $transaction: vi.fn(async (arg: any) =>
      typeof arg === "function" ? arg(prisma) : Promise.all(arg)
    ),
    $disconnect: vi.fn(),
  };
  return { prisma };
});

vi.mock("../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../src/app";

describe("OpenAPI / Swagger spec", () => {
  it("serves the OpenAPI document at /docs/json", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toBe("3.0.0");
  });

  it("documents the expense and settlement operations", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = res.json().paths ?? {};
    expect(paths["/groups/{id}/expenses"]).toBeTruthy();
    expect(paths["/expenses/{id}/settle"]).toBeTruthy();
    expect(paths["/groups/{id}/settlements"]).toBeTruthy();
    // The create-expense route declares a request body schema and a 200
    // response, so both render in the spec.
    const post = paths["/groups/{id}/expenses"]?.post;
    expect(post?.requestBody?.content?.["application/json"]).toBeTruthy();
    expect(post?.responses?.[200]).toBeTruthy();
    expect(post?.summary).toMatch(/Create an expense/i);
  });
});