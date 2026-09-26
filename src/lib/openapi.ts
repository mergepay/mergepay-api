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

/**
 * Error statuses worth documenting on an authenticated write route. Kept as a
 * union (rather than `number`) so a typo in a route's response map is a build
 * error, and so the response descriptions below cannot drift out of sync with
 * the statuses actually rendered.
 */
export type OpenApiErrorStatus = 400 | 401 | 403 | 404 | 409 | 429;

const ERROR_RESPONSE_DESCRIPTIONS: Record<OpenApiErrorStatus, string> = {
  400: "Bad Request — the request body, path, or query failed validation.",
  401: "Unauthorized — a valid bearer token is required.",
  403: "Forbidden — the caller is not allowed to perform this action.",
  404: "Not Found — the addressed resource does not exist or is not visible to the caller.",
  409: "Conflict — the request conflicts with the resource's current state.",
  429: "Too Many Requests — the caller exceeded a rate limit.",
};

/**
 * The API's standard error envelope (`{ error: { code, message, requestId } }`),
 * documented permissively so Fastify's response serializer never strips a
 * field the handler actually sent. Mirrors `formatErrorResponse` in
 * src/utils/error-response.ts.
 */
export function openApiErrorSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      error: {
        type: "object",
        additionalProperties: true,
        properties: {
          code: { type: "string" },
          message: { type: "string" },
          timestamp: { type: "string", format: "date-time" },
          requestId: { type: "string" },
        },
      },
    },
  };
}

/**
 * Response-map fragment documenting the standard error envelope for each
 * requested status. Spread it into a route's `response` map next to the
 * success schema:
 *
 * ```
 * response: {
 *   ...openApiEnvelope("group"),
 *   ...openApiErrorResponses(400, 401, 403, 404),
 * }
 * ```
 */
export function openApiErrorResponses(
  ...statuses: OpenApiErrorStatus[]
): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  for (const status of statuses) {
    responses[status] = {
      description: ERROR_RESPONSE_DESCRIPTIONS[status],
      ...openApiErrorSchema(),
    };
  }
  return responses;
}

/**
 * OpenAPI 200 response for an arbitrary documented JSON body. `properties` are
 * rendered but never `required`, and `additionalProperties` stays `true`, so
 * the route keeps returning exactly what its handler produced.
 */
export function openApiResponse(
  properties: Record<string, unknown>,
  required: string[] = []
): Record<string, unknown> {
  return {
    200: {
      type: "object",
      additionalProperties: true,
      ...(required.length > 0 ? { required } : {}),
      properties,
    },
  };
}

/** OpenAPI 200 response for a `{ ok: true }` acknowledgement body. */
export function openApiOkResponse(): Record<string, unknown> {
  return openApiResponse({ ok: { type: "boolean" } }, ["ok"]);
}