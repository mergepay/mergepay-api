import { FastifyInstance } from "fastify";
import { getReadiness } from "../services/health";
import { getAuthHealth } from "../services/auth-health";
import { prisma } from "../db";

let lastLoggedDegradedReadiness: string | null = null;

export default async function healthRoutes(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        tags: ["System"],
        summary: "Health readiness check",
        description:
          "Performs readiness check against database and Stellar Horizon network services, returning service status and component diagnostics.",
        response: {
          200: {
            description: "Service is healthy and all components are operational",
            type: "object",
            properties: {
              status: { type: "string", example: "ok" },
              database: {
                type: "object",
                properties: {
                  connected: { type: "boolean", example: true },
                },
              },
              stellar: {
                type: "object",
                properties: {
                  reachable: { type: "boolean", example: true },
                  network: { type: "string", example: "testnet" },
                },
              },
              timestamp: { type: "string", format: "date-time" },
            },
          },
          503: {
            description: "Service is degraded or a core dependency is unreachable",
            type: "object",
            properties: {
              status: { type: "string", example: "degraded" },
              database: {
                type: "object",
                properties: {
                  connected: { type: "boolean", example: false },
                },
              },
              stellar: {
                type: "object",
                properties: {
                  reachable: { type: "boolean", example: false },
                  network: { type: "string", example: "testnet" },
                },
              },
              timestamp: { type: "string", format: "date-time" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const readiness = await getReadiness();
      const statusCode = readiness.status === "ok" ? 200 : 503;

      if (
        statusCode === 503 &&
        lastLoggedDegradedReadiness !== readiness.timestamp
      ) {
        request.log.warn(
          {
            databaseConnected: readiness.database.connected,
            stellarReachable: readiness.stellar.reachable,
            network: readiness.stellar.network,
          },
          "Health readiness check is degraded"
        );
        lastLoggedDegradedReadiness = readiness.timestamp;
      }

      return reply.code(statusCode).send(readiness);
    }
  );

  app.get(
    "/health/auth",
    {
      schema: {
        tags: ["System"],
        summary: "SEP-10 authentication dependency health",
        description:
          "Reports whether the dependencies SEP-10 authentication needs are usable: the server signing key loads and Stellar Horizon (the signer lookup used during verification) answers. Returns 200 when both are healthy and 503 when either is not, so an orchestrator can drain an instance whose logins would fail closed. The payload contains booleans only — never key material, signatures, or upstream error text.",
        response: {
          200: {
            description: "Every authentication dependency is healthy",
            type: "object",
            required: ["status", "checks"],
            properties: {
              status: { type: "string", example: "ok" },
              checks: {
                type: "object",
                required: ["signingKey", "horizon"],
                properties: {
                  signingKey: { type: "boolean", example: true },
                  horizon: { type: "boolean", example: true },
                },
              },
            },
          },
          503: {
            description: "At least one authentication dependency is unavailable",
            type: "object",
            required: ["status", "checks"],
            properties: {
              status: { type: "string", example: "degraded" },
              checks: {
                type: "object",
                required: ["signingKey", "horizon"],
                properties: {
                  signingKey: { type: "boolean", example: false },
                  horizon: { type: "boolean", example: false },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const health = await getAuthHealth();
      const statusCode = health.status === "ok" ? 200 : 503;

      if (statusCode === 503) {
        request.log.warn({ checks: health.checks }, "Auth dependency health check is degraded");
      }

      return reply.code(statusCode).send(health);
    }
  );

  app.get(
    "/health/ready",
    {
      schema: {
        tags: ["System"],
        summary: "Readiness probe",
        description:
          "Readiness probe that verifies the database connection before reporting healthy.",
        response: {
          200: {
            description: "Service is ready to accept traffic",
            type: "object",
            properties: {
              status: { type: "string", example: "ok" },
            },
          },
          503: {
            description: "Service is not ready because a dependency is unavailable",
            type: "object",
            properties: {
              status: { type: "string", example: "unavailable" },
              dependency: { type: "string", example: "database" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const timeoutMs = 2000;
        const dbCheck = Promise.resolve(
          typeof (prisma as any).$queryRawUnsafe === "function"
            ? (prisma as any).$queryRawUnsafe("SELECT 1")
            : (prisma as any).$queryRaw`SELECT 1`
        ).then(() => true, () => false);
        const connected = await Promise.race<boolean>([
          dbCheck,
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
        if (connected) {
          return reply.code(200).send({ status: "ok" });
        }
        request.log.warn({ dependency: "database" }, "Readiness probe failed");
        return reply.code(503).send({ status: "unavailable", dependency: "database" });
      } catch (err) {
        request.log.warn({ err, dependency: "database" }, "Readiness probe failed");
        return reply.code(503).send({ status: "unavailable", dependency: "database" });
      }
    }
  );
}
