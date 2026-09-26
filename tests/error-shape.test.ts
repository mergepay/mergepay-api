import { beforeAll, describe, it, expect } from "vitest";
import { buildApp } from "../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

describe("Standardized error envelope", () => {
  it("returns canonical error envelope for validation failures (400)", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/challenge", payload: {} });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(typeof body.error).toBe("object");
    expect(body.error.code).toBe(body.code);
    expect(body.error.message).toBe(body.message);
    expect(body.error.timestamp).toBeTruthy();
    expect(body.requestId).toBeTruthy();
  });

  it("returns canonical error envelope for unauthorized access (401)", async () => {
    const res = await app.inject({ method: "GET", url: "/me" });
    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error).toBeDefined();
    expect(typeof body.error).toBe("object");
    expect(body.error.code).toBe(body.code);
    expect(body.error.message).toBe(body.message);
    expect(body.error.timestamp).toBeTruthy();
    expect(body.requestId).toBeTruthy();
  });
});
