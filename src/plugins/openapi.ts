import { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { config } from "../config";

export default async function openAPIPlugin(app: FastifyInstance) {
  await app.register(fastifySwagger, {
    openapi: {
      openapi: "3.0.0",
      info: {
        title: "Mergepay API",
        description: "Stellar-native group expense settlement engine",
        version: "0.1.0",
        contact: {
          name: "Mergepay",
          url: "https://mergepay.vercel.app",
        },
      },
      servers: [
        {
          url: config.API_URL,
          description: "API server",
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
              shares: { type: "array" },
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
}
