import { FastifyInstance } from "fastify";
import fastifySwagger from "@fastify/swagger";
import fastifySwaggerUi from "@fastify/swagger-ui";
import { config } from "../config";

function routeTag(url: string | undefined): string {
  const segments = (url ?? "/").split("/").filter(Boolean);
  return segments[0] ?? "general";
}

export default async function openAPIPlugin(app: FastifyInstance) {
  app.addHook("onRoute", (routeOptions) => {
    const schema = routeOptions.schema ?? {};
    const response = { ...schema.response };
    const sameStatus = (status: number) => ({
      ...(response[status as keyof typeof response] ?? {}),
      description: response[status as keyof typeof response]?.description ?? "Response",
    });

    routeOptions.schema = {
      ...schema,
      description:
        schema.description ??
        `Endpoint for ${routeOptions.method?.join(", ")?.toUpperCase() ?? "route"} ${routeOptions.url ?? "/"}`,
      tags: Array.from(new Set([...(schema.tags ?? []), routeTag(routeOptions.url)])),
      response: {
        "200": sameStatus(200),
        "400": {
          $ref: "Error",
          ...((response[400] as Record<string, unknown> | undefined) ?? {}),
        },
        "401": {
          $ref: "Error",
          ...((response[401] as Record<string, unknown> | undefined) ?? {}),
        },
        "500": {
          $ref: "Error",
          ...((response[500] as Record<string, unknown> | undefined) ?? {}),
        },
        ...response,
      },
    };
  });

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
