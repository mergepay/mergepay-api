/**
 * Shared helpers for attaching OpenAPI (Swagger) annotations to Fastify routes.
 *
 * The app registers @fastify/swagger + @fastify/swagger-ui (src/plugins/openapi.ts),
 * which derive the documented request/response shapes from each route's Fastify
 * `schema`. These helpers convert a Zod schema into an OpenAPI body schema and
 * provide a permissive 200-envelope response schema.
 *
 * Both helpers intentionally make their JSON schemas *permissive* (no `required`,
 * `additionalProperties: true`) so Fastify does not start rejecting requests or
 * stripping response fields through them. They exist to document the API in the
 * Swagger UI; the routes keep enforcing their real invariants with Zod inside
 * each handler.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/** OpenAPI request-body schema derived from a Zod schema for documentation. */
export function openApiBody(schema: z.ZodTypeAny): Record<string, unknown> {
  return {
    ...(zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>),
    additionalProperties: true,
    required: [],
  };
}

/** OpenAPI 200 response map for a `{ <envelope>: {...} }` JSON body. */
export function openApiEnvelope(envelope: string): Record<string, unknown> {
  return {
    200: {
      type: "object",
      additionalProperties: true,
      required: [envelope],
      properties: {
        [envelope]: { type: "object", additionalProperties: true },
      },
    },
  };
}

/** OpenAPI params schema for a route carrying a single `id` path parameter. */
export function openApiIdParams(): Record<string, unknown> {
  return {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  };
}