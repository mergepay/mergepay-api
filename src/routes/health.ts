import { readFileSync } from "node:fs";
import { FastifyInstance } from "fastify";
import { config } from "../config";
import { prisma } from "../db";

const HEALTH_TIMEOUT_MS = 2000;
const packageVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
).version as string;

interface DependencyHealth {
  status: "up" | "down";
  latencyMs: number;
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

async function checkDatabase(): Promise<DependencyHealth> {
  const startedAt = Date.now();

  try {
    await withTimeout(prisma.$queryRawUnsafe("SELECT 1"), HEALTH_TIMEOUT_MS);
    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch {
    return { status: "down", latencyMs: Date.now() - startedAt };
  }
}

async function checkHorizon(): Promise<DependencyHealth> {
  const startedAt = Date.now();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const response = await fetch(new URL("/", config.HORIZON_URL), {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(`Horizon returned ${response.status}`);
    }

    return { status: "up", latencyMs: Date.now() - startedAt };
  } catch {
    return { status: "down", latencyMs: Date.now() - startedAt };
  }
}

export default async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    {
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_HEALTH,
          timeWindow: config.RATE_LIMIT_WINDOW_MS,
          hook: "onRequest",
        },
      },
      schema: {
        tags: ["Health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              uptime: { type: "number" },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      return reply.code(200).send({
        status: "ok",
        uptime: Math.floor(process.uptime()),
        version: packageVersion,
      });
    }
  );

  app.get(
    "/health/ready",
    {
      config: {
        rateLimit: {
          max: config.RATE_LIMIT_HEALTH,
          timeWindow: config.RATE_LIMIT_WINDOW_MS,
          hook: "onRequest",
        },
      },
      schema: {
        tags: ["Health"],
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              uptime: { type: "number" },
              version: { type: "string" },
              database: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  latencyMs: { type: "number" },
                },
              },
              stellar: {
                type: "object",
                properties: {
                  status: { type: "string" },
                  latencyMs: { type: "number" },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      const [database, stellar] = await Promise.all([checkDatabase(), checkHorizon()]);
      const status = database.status === "up" && stellar.status === "up" ? "ok" : "degraded";
      const payload = {
        status,
        uptime: Math.floor(process.uptime()),
        version: packageVersion,
        database,
        stellar,
      };

      return reply.code(status === "ok" ? 200 : 503).send(payload);
    }
  );
}
