import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => {
  const mockQueryRaw = vi.fn();
  const prisma = {
    $queryRaw: mockQueryRaw,
    $disconnect: vi.fn(),
  };
  const mockFetchBaseFee = vi.fn();
  return { prisma, mockQueryRaw, mockFetchBaseFee };
});

vi.mock("../../src/db", () => ({ prisma: h.prisma }));

vi.mock("@stellar/stellar-sdk", async (importActual) => {
  const actual = await importActual<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        fetchBaseFee: h.mockFetchBaseFee,
      })),
    },
  };
});

import { buildApp } from "../../src/app";

let app: Awaited<ReturnType<typeof buildApp>>;

beforeEach(async () => {
  vi.clearAllMocks();
  if (!app) app = await buildApp();
});

describe("GET /health", () => {
  it("returns 200 when all components healthy", async () => {
    h.mockQueryRaw.mockResolvedValueOnce([{ 1: 1 }]);
    h.mockFetchBaseFee.mockResolvedValueOnce(100);

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.components.database).toBe("connected");
    expect(body.components.stellar).toBe("reachable");
  });

  it("returns 503 with degraded status when DB is unreachable", async () => {
    h.mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"));
    h.mockFetchBaseFee.mockResolvedValueOnce(100);

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.components.database).toBe("unreachable");
    expect(body.components.stellar).toBe("reachable");
  });

  it("returns 503 with degraded status when stellar is unreachable", async () => {
    h.mockQueryRaw.mockResolvedValueOnce([{ 1: 1 }]);
    h.mockFetchBaseFee.mockRejectedValueOnce(new Error("timeout"));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.components.database).toBe("connected");
    expect(body.components.stellar).toBe("unreachable");
  });

  it("returns 503 when both DB and stellar are unreachable", async () => {
    h.mockQueryRaw.mockRejectedValueOnce(new Error("connection refused"));
    h.mockFetchBaseFee.mockRejectedValueOnce(new Error("timeout"));

    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe("degraded");
    expect(body.components.database).toBe("unreachable");
    expect(body.components.stellar).toBe("unreachable");
  });
});
