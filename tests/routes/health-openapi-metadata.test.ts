import { describe, it, expect, vi, beforeAll } from "vitest";

vi.mock("../../src/db", () => {
  const model = () => ({
    create: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(async () => []),
    update: vi.fn(),
    delete: vi.fn(),
    count: vi.fn(async () => 0),
  });
  const prisma: any = {
    user: model(),
    group: model(),
    groupMember: model(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { prisma };
});

import { buildApp } from "../../src/app";
import { getWorkerHealth } from "../../src/worker/health";

let spec: any;

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  spec = (app as any).swagger();
});

describe("OpenAPI metadata for health routes (#378)", () => {
  it("registers System tag in openapi spec", () => {
    const tagNames = spec.tags?.map((t: any) => t.name) || [];
    expect(tagNames).toContain("System");
  });

  it("documents /health with System tag, summary, description, and response schemas", () => {
    const op = spec.paths["/health"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("System");
    expect(op.summary).toBe("Health readiness check");
    expect(op.description).toContain("readiness check");
    expect(op.responses).toBeDefined();
    expect(op.responses["200"]).toBeDefined();
    expect(op.responses["503"]).toBeDefined();
  });

  it("documents /health/ready with readiness probe schema", () => {
    const op = spec.paths["/health/ready"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("System");
    expect(op.summary).toBe("Readiness probe");
    expect(op.responses["200"]).toBeDefined();
    expect(op.responses["503"]).toBeDefined();
  });

  it("documents /health/live with System tag, summary, and description", () => {
    const op = spec.paths["/health/live"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("System");
    expect(op.summary).toBe("Health liveness check");
    expect(op.description).toBeDefined();
    expect(op.responses["200"]).toBeDefined();
  });

  // Issue #1070: the deep probe was registered with no OpenAPI metadata at
  // all, so a generated client had no way to type its payload.
  it("documents /health/deep with System tag, summary, description, and both response codes", () => {
    const op = spec.paths["/health/deep"]?.get;
    expect(op).toBeDefined();
    expect(op.tags).toContain("System");
    expect(op.summary).toBe("Deep health check with dependency latency");
    expect(op.description).toContain("dependency");
    expect(op.responses["200"]).toBeDefined();
    expect(op.responses["503"]).toBeDefined();

    const schema = op.responses["200"].content["application/json"].schema;
    expect(schema.required).toEqual([
      "status",
      "timestamp",
      "uptime",
      "checks",
      "environment",
    ]);
    // The document must cover the whole payload: Fastify serializes through
    // this schema, so an omitted property would disappear from the response.
    expect(Object.keys(schema.properties).sort()).toEqual(
      ["checks", "environment", "status", "timestamp", "uptime"].sort()
    );
    // Inlined, not a $ref: Fastify compiles this schema into the response
    // serializer, which cannot resolve components references.
    const database = schema.properties.checks.properties.database;
    expect(Object.keys(database.properties).sort()).toEqual(["latencyMs", "status"]);
    expect(database.properties.status.enum).toEqual(["up", "down"]);
  });

  // The worker has no HTTP endpoint by design (HEALTH.md): its health travels
  // on the structured heartbeat log line. That contract still belongs in the
  // spec, and this test keeps it identical to the payload the worker emits.
  it("publishes a WorkerHealth model that matches getWorkerHealth() exactly", () => {
    const schema = spec.components.schemas.WorkerHealth;
    expect(schema).toBeDefined();
    expect(Object.keys(schema.properties).sort()).toEqual(
      Object.keys(getWorkerHealth()).sort()
    );
  });
});
