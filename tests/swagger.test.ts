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

  it("declares top-level documentation tags", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const tags = res.json().tags ?? [];
    const tagNames = tags.map((t: { name: string }) => t.name);
    expect(tagNames).toContain("Auth");
    expect(tagNames).toContain("SEP-24");
    expect(tagNames).toContain("Expenses");
    expect(tagNames).toContain("Settlements");
    expect(tagNames).toContain("Treasury");
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
    expect(post?.tags).toContain("Expenses");
  });

  it("documents SEP-10 Auth endpoints with tags and descriptions", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = res.json().paths ?? {};

    // POST /auth/challenge
    const challenge = paths["/auth/challenge"]?.post;
    expect(challenge).toBeTruthy();
    expect(challenge?.tags).toContain("Auth");
    expect(challenge?.summary).toMatch(/challenge/i);
    expect(challenge?.description).toBeTruthy();
    expect(challenge?.responses?.[200]).toBeTruthy();

    // POST /auth/verify
    const verify = paths["/auth/verify"]?.post;
    expect(verify).toBeTruthy();
    expect(verify?.tags).toContain("Auth");
    expect(verify?.summary).toMatch(/verify/i);
    expect(verify?.description).toBeTruthy();
    expect(verify?.responses?.[200]).toBeTruthy();

    // POST /auth/refresh
    const refresh = paths["/auth/refresh"]?.post;
    expect(refresh).toBeTruthy();
    expect(refresh?.tags).toContain("Auth");
    expect(refresh?.summary).toMatch(/refresh/i);

    // POST /auth/logout
    const logout = paths["/auth/logout"]?.post;
    expect(logout).toBeTruthy();
    expect(logout?.tags).toContain("Auth");

    // GET /me
    const getMe = paths["/me"]?.get;
    expect(getMe).toBeTruthy();
    expect(getMe?.tags).toContain("Auth");
  });

  it("documents SEP-24 anchor endpoints with tags and descriptions", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = res.json().paths ?? {};

    // POST /api/sep24/callback
    const callback = paths["/api/sep24/callback"]?.post;
    expect(callback).toBeTruthy();
    expect(callback?.tags).toContain("SEP-24");
    expect(callback?.summary).toMatch(/callback/i);
    expect(callback?.description).toBeTruthy();

    // POST /anchors/deposit
    const deposit = paths["/anchors/deposit"]?.post;
    expect(deposit).toBeTruthy();
    expect(deposit?.tags).toContain("SEP-24");
    expect(deposit?.summary).toMatch(/deposit/i);

    // POST /anchors/withdraw
    const withdraw = paths["/anchors/withdraw"]?.post;
    expect(withdraw).toBeTruthy();
    expect(withdraw?.tags).toContain("SEP-24");
    expect(withdraw?.summary).toMatch(/withdraw/i);

    // POST /anchors/sessions/{id}/complete
    const complete = paths["/anchors/sessions/{id}/complete"]?.post;
    expect(complete).toBeTruthy();
    expect(complete?.tags).toContain("SEP-24");

    // GET /anchors
    const anchors = paths["/anchors"]?.get;
    expect(anchors).toBeTruthy();
    expect(anchors?.tags).toContain("SEP-24");
  });

  it("documents Treasury endpoints with tags and descriptions", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/docs/json" });
    const paths = res.json().paths ?? {};

    // POST /groups/{id}/treasury/enable
    const enable = paths["/groups/{id}/treasury/enable"]?.post;
    expect(enable).toBeTruthy();
    expect(enable?.tags).toContain("Treasury");
    expect(enable?.summary).toMatch(/Enable group treasury/i);

    // GET /groups/{id}/treasury
    const getTreasury = paths["/groups/{id}/treasury"]?.get;
    expect(getTreasury).toBeTruthy();
    expect(getTreasury?.tags).toContain("Treasury");

    // POST /groups/{id}/treasury/deposit
    const deposit = paths["/groups/{id}/treasury/deposit"]?.post;
    expect(deposit).toBeTruthy();
    expect(deposit?.tags).toContain("Treasury");

    // POST /groups/{id}/treasury/withdraw
    const withdraw = paths["/groups/{id}/treasury/withdraw"]?.post;
    expect(withdraw).toBeTruthy();
    expect(withdraw?.tags).toContain("Treasury");
  });
});