/**
 * Reusable Zod request-validation middleware (#915).
 *
 * A route declares which parts of the request it owns and the Zod schema for
 * each; the returned Fastify `preHandler` parses them in a fixed order —
 * `params`, then `query`, then `body` — and writes the parsed result back onto
 * the request. The write-back matters: these schemas transform as well as
 * check (`assetCode` is upper-cased on parse), so the handler reads the
 * normalised value rather than re-deriving it.
 *
 * ## The 400 contract
 *
 * On a failure the middleware throws the raw `ZodError` and nothing else. The
 * central error handler (src/plugins/error-handler.ts) is the single place
 * that renders it, so every rejection — whichever route, whichever part of the
 * request — arrives as the same `400 VALIDATION_ERROR` envelope carrying both
 * `details` (per-field) and `issues` (the full Zod view). Wrapping the error
 * here would fork that contract: an `AppError` would lose the `issues` array
 * the SEP-24 surfaces are specified to return.
 *
 * ## Why a `preHandler`
 *
 * Validation must run after the route's `authenticate` hook (so an
 * unauthenticated request is a 401, not a 400) and before the handler touches
 * an anchor, the database, or the audit log. Register it in the route's
 * `preHandler` array, after `app.authenticate`:
 *
 *   app.post("/thing", { preHandler: [app.authenticate, validateRequest({ body }) ] }, handler)
 */
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import { type ZodTypeAny } from "zod";

/**
 * The request parts a route validates, and the schema for each.
 *
 * Every part is optional; a route names only what its contract covers. A part
 * left out is passed through untouched, so the middleware never becomes a
 * second, implicit source of rules for something it was not asked to check.
 */
export interface RequestValidationSchemas {
  /** Schema for the path parameters (`req.params`). */
  params?: ZodTypeAny;
  /** Schema for the query string (`req.query`). */
  query?: ZodTypeAny;
  /** Schema for the JSON body (`req.body`). */
  body?: ZodTypeAny;
}

/**
 * Build a `preHandler` that validates the named request parts with Zod.
 *
 * Parsing is ordered `params` → `query` → `body` so a rejection is reported
 * for the part a client is most likely to have got wrong first; the order is
 * otherwise irrelevant because the parts are independent. A body schema is
 * applied to `req.body` as-is (not defaulted to `{}`) so a missing body is
 * rejected by the schema rather than silently replaced with an empty object.
 */
export function validateRequest(
  schemas: RequestValidationSchemas
): preHandlerHookHandler {
  return async function validateRequestHandler(
    req: FastifyRequest
  ): Promise<void> {
    if (schemas.params) {
      req.params = schemas.params.parse(req.params ?? {});
    }
    if (schemas.query) {
      req.query = schemas.query.parse(req.query ?? {});
    }
    if (schemas.body) {
      req.body = schemas.body.parse(req.body);
    }
  };
}
