import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const mockQueryRaw = vi.fn();
  const prisma: any = {
    $queryRaw: mockQueryRaw,
    $disconnect: vi.fn(),
  };
  return { prisma, mockQueryRaw };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

import { buildApp } from "../../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("health endpoint", () => {
  it("returns 200 with healthy status when database is reachable", async () => {
    h.mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("healthy");
    expect(body.timestamp).toBeTruthy();
    expect(new Date(body.timestamp).toString()).not.toBe("Invalid Date");
  });

  it("returns 503 with degraded status when database is unreachable", async () => {
    h.mockQueryRaw.mockRejectedValueOnce(new Error("Connection refused"));

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.db).toBe("unhealthy");
    expect(body.timestamp).toBeTruthy();
  });

  it("does not require authentication", async () => {
    h.mockQueryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("ok");
  });
});