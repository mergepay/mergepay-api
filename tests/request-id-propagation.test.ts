import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../src/db", () => ({
  prisma: {
    user: { findUnique: vi.fn(), upsert: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
  app.get("/__test/request-id/boom", async () => {
    throw new Error("boom");
  });
  app.get("/__test/request-id/ok", async () => ({ ok: true }));
});

afterAll(async () => {
  await app?.close();
});

describe("request-id propagation (#1012)", () => {
  it("includes x-request-id header on successful responses", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/request-id/ok" });
    expect(res.statusCode).toBe(200);
    expect(typeof res.headers["x-request-id"]).toBe("string");
    expect((res.headers["x-request-id"] as string).length).toBeGreaterThan(0);
  });

  it("echoes a client-supplied x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__test/request-id/ok",
      headers: { "x-request-id": "req-client-123" },
    });
    expect(res.headers["x-request-id"]).toBe("req-client-123");
  });

  it("generates x-request-id when absent", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/request-id/ok" });
    const id = res.headers["x-request-id"];
    expect(typeof id).toBe("string");
    expect(id).not.toBe("");
  });

  it("includes requestId in error response bodies", async () => {
    const res = await app.inject({ method: "GET", url: "/__test/request-id/boom" });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.requestId).toBeTruthy();
    expect(body.error.requestId).toBe(body.requestId);
    expect(res.headers["x-request-id"]).toBe(body.requestId);
  });

  it("echoes client x-request-id on error responses", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/__test/request-id/boom",
      headers: { "x-request-id": "req-error-echo" },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.requestId).toBe("req-error-echo");
    expect(body.error.requestId).toBe("req-error-echo");
    expect(res.headers["x-request-id"]).toBe("req-error-echo");
  });

  it("includes requestId on 404 responses", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/no/such/route",
      headers: { "x-request-id": "req-404" },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.requestId).toBe("req-404");
    expect(body.error.requestId).toBe("req-404");
  });
});
