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
 *
 * `openApiBody(schema, { enforce: false })` takes that one step further for a
 * route whose Zod schema *is* the request contract — see `RULE_KEYWORDS` below
 * for what it removes and why. Without it, a JSON Schema derived from a Zod
 * schema is a second, weaker copy of the same rules: Fastify rejects the
 * request in ajv's words ("must match pattern …", code FST_ERR_VALIDATION)
 * before the handler's Zod parse can report the message the project actually
 * documents, and the response loses the `issues` array every Zod rejection
 * carries. One validator, one error contract.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * JSON Schema keywords that state a *rule* — zod-to-json-schema emits them from
 * Zod checks (`.min()`, `.regex()`, `.refine()`, …) and Fastify's validator
 * (ajv) enforces them against an incoming body. They are dropped from a
 * documentation-only body schema so the handler's Zod parse is the sole
 * validator.
 *
 * What is left describes the payload's *shape* — `type`, `properties`,
 * `required`, `items`, `allOf`/`anyOf`/`oneOf`, `$ref`, `description`,
 * `default` — and is what the OpenAPI spec is built from. Compositions are
 * recursed into rather than removed, so a piped or refined field still shows
 * its type in Swagger (`.length(56).pipe(...)` renders as an `allOf` of
 * strings).
 *
 * Of the leftovers, only `type` can still reject a body, and only for a value
 * that is not the primitive the field is documented as — `{ "transaction":
 * 12345 }`. That answer is the correct one, and the error handler renders it in
 * the same envelope, `details`, and `issues` shape a Zod rejection uses, so a
 * client cannot tell the two validators apart. ajv's type coercion is disabled
 * factory-wide (src/app.ts) so the value it judges is the one the client sent.
 * `required` is emptied above for the same reason: the Zod schema owns which
 * fields are mandatory.
 */
const RULE_KEYWORDS = new Set([
  "const",
  "contains",
  "else",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "if",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "pattern",
  "patternRequired",
  "propertyNames",
  "then",
  "uniqueItems",
]);

/** Recursively drop the rule keywords from a JSON Schema tree. */
function withoutRules(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutRules);
  if (!node || typeof node !== "object") return node;

  const result: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(node as Record<string, unknown>)) {
    if (RULE_KEYWORDS.has(keyword)) continue;
    result[keyword] = withoutRules(value);
  }
  return result;
}

/** How a request body schema is annotated on a route. */
export interface OpenApiBodyOptions {
  /**
   * Set to `false` when the handler parses the body with the same Zod schema and
   * must be the only thing that can reject it. The body is then documented
   * without the constraints that would let Fastify pre-empt the handler.
   */
  enforce?: boolean;
}

/** OpenAPI request-body schema derived from a Zod schema for documentation. */
export function openApiBody(
  schema: z.ZodTypeAny,
  options: OpenApiBodyOptions = {}
): Record<string, unknown> {
  const derived = zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>;
  const permissive: Record<string, unknown> = {
    ...derived,
    additionalProperties: true,
    required: [],
  };
  return options.enforce === false
    ? (withoutRules(permissive) as Record<string, unknown>)
    : permissive;
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