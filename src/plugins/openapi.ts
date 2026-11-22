import { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import fp from "fastify-plugin";
import { config } from "../config";

export default fp(async function openAPIPlugin(app: FastifyInstance) {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "Mergepay API",
        description:
          "Stellar-native group expense settlement engine. Mergepay lets groups track shared expenses, split them fairly, and settle balances on the Stellar network: SEP-10 wallet authentication, multi-asset expenses with receipt storage, fair split strategies, signature-based settlement with multi-signature treasury accounts, and SEP-24 anchor integration for on/off-ramps.",
        version: "0.1.0",
        // Kept in sync with package.json (importing the file directly is not
        // possible under this repo's `rootDir: "src"` build setup).
        termsOfService: "https://github.com/mergepay/mergepay-api/blob/main/SECURITY.md",
        contact: {
          name: "Mergepay",
          url: "https://mergepay.vercel.app",
          email: "support@mergepay.com",
        },
        license: {
          name: "MIT",
          // OpenAPI 3.0 requires an absolute URL; pointing at the repo file
          // keeps the license text (and its copyright) one click away.
          url: "https://github.com/mergepay/mergepay-api/blob/main/LICENSE",
        },
      },
      servers: [
        {
          url: config.API_URL,
          description: "API server",
        },
      ],
      tags: [
        {
          name: "Auth",
          description:
            "SEP-10 Stellar authentication challenge, token verification, session lifecycle, and user profile management",
        },
        {
          name: "SEP-24",
          description:
            "SEP-24 interactive deposit, withdrawal, anchor sessions, and callback endpoints",
        },
        {
          name: "Groups",
          description:
            "Group creation, membership, invitations, roles, and archival",
        },
        {
          name: "Expenses",
          description: "Group expense creation, splits, receipt uploads, and management",
        },
        {
          name: "Settlements",
          description:
            "Settlement intent generation, signatures, and Stellar transaction execution",
        },
        {
          name: "Treasury",
          description:
            "Multi-signature treasury management, deposit/withdraw proposals, and signatures",
        },
        {
          name: "System",
          description:
            "System health checks, readiness and liveness probes, and the background worker's heartbeat contract",
        },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
            description: "Bearer token from /auth/verify",
          },
        },
        schemas: {
          Error: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              stellarPublicKey: { type: "string" },
              displayName: { type: "string" },
              avatarUrl: { type: ["string", "null"] },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          Group: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              description: { type: ["string", "null"] },
              createdByUserId: { type: "string" },
              treasuryEnabled: { type: "boolean" },
              treasuryAccountPublicKey: { type: ["string", "null"] },
              treasuryRequiredSigners: { type: ["integer", "null"] },
              archived: { type: "boolean" },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          Expense: {
            type: "object",
            properties: {
              id: { type: "string" },
              groupId: { type: "string" },
              payerUserId: { type: "string" },
              title: { type: "string" },
              description: { type: ["string", "null"] },
              amount: { type: "string" },
              assetCode: { type: "string" },
              assetIssuer: { type: ["string", "null"] },
              splitType: { type: "string" },
              memo: { type: ["string", "null"] },
              receiptUrl: { type: ["string", "null"] },
              createdAt: { type: "string", format: "date-time" },
              shares: { type: "array", items: { type: "object" } },
            },
          },
          Settlement: {
            type: "object",
            properties: {
              id: { type: "string" },
              groupId: { type: "string" },
              fromUserId: { type: "string" },
              toUserId: { type: "string" },
              amount: { type: "string" },
              assetCode: { type: "string" },
              assetIssuer: { type: ["string", "null"] },
              stellarTxHash: { type: ["string", "null"] },
              status: { type: "string" },
              memo: { type: ["string", "null"] },
              expenseId: { type: ["string", "null"] },
              createdAt: { type: "string", format: "date-time" },
            },
          },
          // The background worker runs as its own process and deliberately
          // exposes no HTTP surface (see HEALTH.md), so its health is published
          // as the `health` object on the structured `worker_health` heartbeat
          // log line. This schema is the contract for that payload; it is
          // derived from `getWorkerHealth()` in src/worker/health.ts, and a test
          // asserts the two cannot drift.
          WorkerHealth: {
            type: "object",
            description:
              "Point-in-time background worker health, emitted as the `health` field of the `worker_health` heartbeat log line. Not served by an HTTP endpoint: the worker is a separate process, so monitor it through its logs and process supervisor.",
            required: [
              "workerId",
              "healthy",
              "startedAt",
              "lastCycleOutcome",
              "cyclesCompleted",
              "cyclesFailed",
              "consecutiveFailures",
              "taskFailures",
              "deadLetteredTasks",
            ],
            properties: {
              workerId: { type: "string" },
              healthy: {
                type: "boolean",
                description:
                  "`false` once consecutive failed cycles reach WORKER_HEALTH_UNHEALTHY_THRESHOLD",
              },
              startedAt: { type: "string", format: "date-time" },
              lastCycleStartedAt: { type: "string", format: "date-time", nullable: true },
              lastCycleCompletedAt: { type: "string", format: "date-time", nullable: true },
              lastCycleDurationMs: { type: "integer", nullable: true },
              lastCycleOutcome: {
                type: "string",
                enum: ["never_run", "running", "success", "failed"],
              },
              cyclesCompleted: { type: "integer" },
              cyclesFailed: { type: "integer" },
              consecutiveFailures: { type: "integer" },
              taskFailures: {
                type: "object",
                description: "Final (budget-exhausted) failures per cycle task, by task name",
                additionalProperties: { type: "integer" },
              },
              deadLetteredTasks: {
                type: "array",
                description: "Tasks whose in-cycle retry budget was exhausted, newest first",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
  });
});
